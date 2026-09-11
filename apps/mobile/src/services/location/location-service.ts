import type { LocationSnapshot } from '@ima/contracts';
import type { LocationObject, LocationPermissionResponse } from 'expo-location';
import type {
  ExpoLocationSdk,
  LocationAcquireOptions,
  LocationAcquireResult,
  LocationService,
  LocationServiceOptions,
} from './types';

export const LOCATION_MAX_AGE_MS = 60_000;
export const LOCATION_TIMEOUT_MS = 5_000;
export const LOCATION_TIMEOUT_CAP_MS = 8_000;
export const LOCATION_PRECISE_ACCURACY_METERS = 100;

type EmptyLocationStatus = Exclude<LocationSnapshot['status'], 'available' | 'reduced'>;

type DeadlineResult<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'timeout' | 'cancelled' }
  | { readonly kind: 'rejected' };

const OPERATION_CANCELLED = new Error('location operation cancelled before native call');
const OPERATION_TIMED_OUT = new Error('location operation exceeded its deadline');

const emptySnapshot = (status: EmptyLocationStatus): LocationSnapshot => ({
  status,
  lat: null,
  lng: null,
  accuracyMeters: null,
  precise: false,
  capturedAt: null,
});

const cancelledResult = (): LocationAcquireResult => ({ status: 'cancelled' });

const finiteNonNegative = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;

const boundedTimeout = (value: number | undefined, fallback: number): number =>
  Math.min(finiteNonNegative(value, fallback), LOCATION_TIMEOUT_CAP_MS);

const boundedMaxAge = (value: number | undefined): number =>
  Math.min(finiteNonNegative(value, LOCATION_MAX_AGE_MS), LOCATION_MAX_AGE_MS);

const preciseThreshold = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : LOCATION_PRECISE_ACCURACY_METERS;

/**
 * Bounds an SDK promise even when the native method cannot receive an
 * AbortSignal. Its rejection handler consumes a late native failure.
 */
const runWithinDeadline = <T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  signal: AbortSignal | undefined,
  now: () => number,
): Promise<DeadlineResult<T>> => {
  if (signal?.aborted) return Promise.resolve({ kind: 'cancelled' });
  const remainingMs = deadlineAt - now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return Promise.resolve({ kind: 'timeout' });
  }

  const operationPromise = Promise.resolve().then(() => {
    const remainingAtStart = deadlineAt - now();
    if (signal?.aborted) throw OPERATION_CANCELLED;
    if (!Number.isFinite(remainingAtStart) || remainingAtStart <= 0) throw OPERATION_TIMED_OUT;
    return operation();
  });
  const settled = operationPromise.then(
    (value) => ({ kind: 'done' as const, value }),
    (error: unknown) => {
      if (error === OPERATION_CANCELLED) return { kind: 'cancelled' as const };
      if (error === OPERATION_TIMED_OUT) return { kind: 'timeout' as const };
      return { kind: 'rejected' as const };
    },
  );

  return new Promise<DeadlineResult<T>>((resolve) => {
    let finished = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (result: DeadlineResult<T>): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };
    const onAbort = (): void => finish({ kind: 'cancelled' });

    const timer = setTimeout(() => finish({ kind: 'timeout' }), remainingMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    void settled.then(finish, () => finish({ kind: 'rejected' }));
  });
};

const isFiniteCoordinate = (value: number, minimum: number, maximum: number): boolean =>
  Number.isFinite(value) && value >= minimum && value <= maximum;

const permissionIsReduced = (permission: LocationPermissionResponse): boolean =>
  permission.ios?.accuracy === 'reduced' || permission.android?.accuracy === 'coarse';

const permissionStatus = (permission: LocationPermissionResponse): string =>
  String(permission.status);

const snapshotFor = (
  location: LocationObject,
  permission: LocationPermissionResponse,
  now: () => number,
  maxAgeMs: number,
  preciseAccuracyMeters: number,
): LocationSnapshot | null => {
  const { coords } = location;
  if (typeof coords !== 'object' || coords === null) return null;
  if (
    !isFiniteCoordinate(coords.latitude, -90, 90) ||
    !isFiniteCoordinate(coords.longitude, -180, 180) ||
    (coords.accuracy !== null && (!Number.isFinite(coords.accuracy) || coords.accuracy < 0))
  ) {
    return null;
  }

  const nowMs = now();
  const capturedAtMs = location.timestamp;
  if (!Number.isFinite(nowMs) || !Number.isFinite(capturedAtMs)) return null;
  const ageMs = nowMs - capturedAtMs;
  if (ageMs < 0 || ageMs > maxAgeMs) return null;

  const measuredPrecisely = coords.accuracy !== null && coords.accuracy <= preciseAccuracyMeters;
  const precise = measuredPrecisely && !permissionIsReduced(permission);
  const capturedAt = new Date(capturedAtMs);
  if (!Number.isFinite(capturedAt.getTime())) return null;
  return {
    status: precise ? 'available' : 'reduced',
    lat: coords.latitude,
    lng: coords.longitude,
    accuracyMeters: coords.accuracy,
    precise,
    capturedAt: capturedAt.toISOString(),
  };
};

const resultFor = <T>(
  outcome: DeadlineResult<T>,
  unavailable: LocationSnapshot,
): LocationAcquireResult | null => {
  if (outcome.kind === 'cancelled') return cancelledResult();
  if (outcome.kind === 'timeout') return emptySnapshot('timeout');
  if (outcome.kind === 'rejected') return unavailable;
  return null;
};

export const createLocationService = (
  sdk: ExpoLocationSdk,
  options: LocationServiceOptions = {},
): LocationService => {
  const now = options.now ?? Date.now;
  const defaultTimeoutMs = boundedTimeout(options.timeoutMs, LOCATION_TIMEOUT_MS);
  const maxAgeMs = boundedMaxAge(options.maxAgeMs);
  const preciseAccuracyMeters = preciseThreshold(options.preciseAccuracyMeters);
  let generation = 0;

  const acquire = async (
    requestOptions: LocationAcquireOptions = {},
  ): Promise<LocationAcquireResult> => {
    const requestGeneration = ++generation;
    const signal = requestOptions.signal;
    const isCurrent = (): boolean => generation === requestGeneration && !signal?.aborted;
    if (!isCurrent()) return cancelledResult();

    const startedAt = now();
    if (!Number.isFinite(startedAt)) return emptySnapshot('unavailable');
    const timeoutMs = boundedTimeout(requestOptions.timeoutMs, defaultTimeoutMs);
    const deadlineAt = startedAt + timeoutMs;
    const invoke = <T>(operation: () => Promise<T>): Promise<DeadlineResult<T>> =>
      runWithinDeadline(operation, deadlineAt, signal, now);

    const permissionOutcome = await invoke(() => sdk.getForegroundPermissionsAsync());
    const permissionFailure = resultFor(permissionOutcome, emptySnapshot('unavailable'));
    if (permissionFailure !== null) return permissionFailure;
    if (!isCurrent()) return cancelledResult();
    if (permissionOutcome.kind !== 'done') return emptySnapshot('unavailable');

    let permission = permissionOutcome.value;
    if (permissionStatus(permission) !== 'granted') {
      if (permissionStatus(permission) === 'denied') return emptySnapshot('denied');
      const requestedOutcome = await invoke(() => sdk.requestForegroundPermissionsAsync());
      const requestFailure = resultFor(requestedOutcome, emptySnapshot('unavailable'));
      if (requestFailure !== null) return requestFailure;
      if (!isCurrent()) return cancelledResult();
      if (requestedOutcome.kind !== 'done') return emptySnapshot('unavailable');
      permission = requestedOutcome.value;
      if (permissionStatus(permission) !== 'granted') return emptySnapshot('denied');
    }

    const servicesOutcome = await invoke(() => sdk.hasServicesEnabledAsync());
    const servicesFailure = resultFor(servicesOutcome, emptySnapshot('unavailable'));
    if (servicesFailure !== null) return servicesFailure;
    if (!isCurrent()) return cancelledResult();
    if (servicesOutcome.kind !== 'done') return emptySnapshot('unavailable');
    if (!servicesOutcome.value) return emptySnapshot('unavailable');

    const lastKnownOutcome = await invoke(() => sdk.getLastKnownPositionAsync(maxAgeMs));
    if (lastKnownOutcome.kind === 'cancelled') return cancelledResult();
    if (lastKnownOutcome.kind === 'timeout') return emptySnapshot('timeout');
    if (!isCurrent()) return cancelledResult();
    if (lastKnownOutcome.kind === 'done' && lastKnownOutcome.value !== null) {
      const lastKnownSnapshot = snapshotFor(
        lastKnownOutcome.value,
        permission,
        now,
        maxAgeMs,
        preciseAccuracyMeters,
      );
      if (lastKnownSnapshot !== null) return isCurrent() ? lastKnownSnapshot : cancelledResult();
    }

    const currentOutcome = await invoke(() => sdk.getCurrentPositionAsync());
    const currentFailure = resultFor(currentOutcome, emptySnapshot('unavailable'));
    if (currentFailure !== null) return currentFailure;
    if (!isCurrent()) return cancelledResult();
    if (currentOutcome.kind !== 'done') return emptySnapshot('unavailable');
    const currentSnapshot = snapshotFor(
      currentOutcome.value,
      permission,
      now,
      maxAgeMs,
      preciseAccuracyMeters,
    );
    if (!isCurrent()) return cancelledResult();
    return currentSnapshot ?? emptySnapshot('unavailable');
  };

  return { acquire };
};
