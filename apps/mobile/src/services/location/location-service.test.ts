import type { LocationObject, LocationPermissionResponse } from 'expo-location';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocationService,
  LOCATION_MAX_AGE_MS,
  LOCATION_TIMEOUT_CAP_MS,
} from '@mobile/services/location/location-service';
import type { ExpoLocationSdk } from '@mobile/services/location/types';

const NOW = Date.parse('2026-09-11T03:00:00.000Z');

type PermissionStatus = 'granted' | 'denied' | 'undetermined';

const permissionFor = (
  status: PermissionStatus,
  details: Pick<NonNullable<LocationPermissionResponse['ios']>, 'accuracy' | 'scope'> | null = null,
): LocationPermissionResponse => {
  const base = {
    status: status as LocationPermissionResponse['status'],
    expires: 'never' as const,
    granted: status === 'granted',
    canAskAgain: status !== 'denied',
  };
  return details === null ? base : { ...base, ios: details };
};

const locationFor = (
  options: {
    readonly ageMs?: number;
    readonly accuracy?: number | null;
    readonly latitude?: number;
    readonly longitude?: number;
    readonly timestamp?: number;
  } = {},
): LocationObject => ({
  coords: {
    latitude: options.latitude ?? 35.6595,
    longitude: options.longitude ?? 139.7005,
    altitude: null,
    accuracy: options.accuracy === undefined ? 20 : options.accuracy,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  },
  timestamp: options.timestamp ?? NOW - (options.ageMs ?? 0),
});

type SdkFixture = {
  readonly sdk: ExpoLocationSdk;
  readonly calls: {
    foreground: number;
    requestForeground: number;
    services: number;
    lastKnown: number;
    current: number;
    lastKnownMaxAgeMs: number | null;
  };
};

const sdkFor = (overrides: Partial<ExpoLocationSdk> = {}): SdkFixture => {
  const calls: SdkFixture['calls'] = {
    foreground: 0,
    requestForeground: 0,
    services: 0,
    lastKnown: 0,
    current: 0,
    lastKnownMaxAgeMs: null,
  };
  const sdk: ExpoLocationSdk = {
    getForegroundPermissionsAsync: () => {
      calls.foreground += 1;
      return Promise.resolve(permissionFor('granted', { accuracy: 'full', scope: 'whenInUse' }));
    },
    requestForegroundPermissionsAsync: () => {
      calls.requestForeground += 1;
      return Promise.resolve(permissionFor('granted', { accuracy: 'full', scope: 'whenInUse' }));
    },
    hasServicesEnabledAsync: () => {
      calls.services += 1;
      return Promise.resolve(true);
    },
    getLastKnownPositionAsync: (maxAgeMs) => {
      calls.lastKnown += 1;
      calls.lastKnownMaxAgeMs = maxAgeMs;
      return Promise.resolve(locationFor());
    },
    getCurrentPositionAsync: () => {
      calls.current += 1;
      return Promise.resolve(locationFor());
    },
    ...overrides,
  };
  return { sdk, calls };
};

afterEach(() => {
  vi.useRealTimers();
});

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
};

describe('createLocationService', () => {
  it('does not touch the SDK until acquire and reuses a fresh precise position', async () => {
    const fixture = sdkFor();
    const service = createLocationService(fixture.sdk, { now: () => NOW });

    expect(fixture.calls).toMatchObject({
      foreground: 0,
      requestForeground: 0,
      services: 0,
      lastKnown: 0,
      current: 0,
    });
    await expect(service.acquire()).resolves.toEqual({
      status: 'available',
      lat: 35.6595,
      lng: 139.7005,
      accuracyMeters: 20,
      precise: true,
      capturedAt: '2026-09-11T03:00:00.000Z',
    });
    expect(fixture.calls).toMatchObject({
      foreground: 1,
      requestForeground: 0,
      services: 1,
      lastKnown: 1,
      current: 0,
      lastKnownMaxAgeMs: LOCATION_MAX_AGE_MS,
    });
  });

  it('requests When In Use only for an undetermined permission and preserves denial', async () => {
    const fixture = sdkFor({
      getForegroundPermissionsAsync: () => Promise.resolve(permissionFor('undetermined')),
      requestForegroundPermissionsAsync: () => Promise.resolve(permissionFor('denied')),
    });

    await expect(createLocationService(fixture.sdk, { now: () => NOW }).acquire()).resolves.toEqual(
      {
        status: 'denied',
        lat: null,
        lng: null,
        accuracyMeters: null,
        precise: false,
        capturedAt: null,
      },
    );
    expect(fixture.calls.requestForeground).toBe(0);
  });

  it('does not request again after an already denied permission', async () => {
    const fixture = sdkFor({
      getForegroundPermissionsAsync: () => Promise.resolve(permissionFor('denied')),
    });

    await expect(
      createLocationService(fixture.sdk, { now: () => NOW }).acquire(),
    ).resolves.toMatchObject({
      status: 'denied',
    });
    expect(fixture.calls.requestForeground).toBe(0);
    expect(fixture.calls.services).toBe(0);
  });

  it('maps reduced permission to a reduced snapshot without inventing precision', async () => {
    const fixture = sdkFor({
      getForegroundPermissionsAsync: () =>
        Promise.resolve(permissionFor('granted', { accuracy: 'reduced', scope: 'whenInUse' })),
      getLastKnownPositionAsync: () => Promise.resolve(locationFor({ accuracy: 10 })),
    });

    await expect(createLocationService(fixture.sdk, { now: () => NOW }).acquire()).resolves.toEqual(
      {
        status: 'reduced',
        lat: 35.6595,
        lng: 139.7005,
        accuracyMeters: 10,
        precise: false,
        capturedAt: '2026-09-11T03:00:00.000Z',
      },
    );
  });

  it('returns unavailable when location services are disabled', async () => {
    const fixture = sdkFor({ hasServicesEnabledAsync: () => Promise.resolve(false) });

    await expect(
      createLocationService(fixture.sdk, { now: () => NOW }).acquire(),
    ).resolves.toMatchObject({
      status: 'unavailable',
      lat: null,
      lng: null,
    });
    expect(fixture.calls.lastKnown).toBe(0);
    expect(fixture.calls.current).toBe(0);
  });

  it('falls back to a one-shot current fix when no usable last-known position exists', async () => {
    let currentCalls = 0;
    const fixture = sdkFor({
      getLastKnownPositionAsync: () => Promise.resolve(null),
      getCurrentPositionAsync: () => {
        currentCalls += 1;
        return Promise.resolve(locationFor({ accuracy: 100 }));
      },
    });

    await expect(
      createLocationService(fixture.sdk, { now: () => NOW }).acquire(),
    ).resolves.toMatchObject({
      status: 'available',
      accuracyMeters: 100,
      precise: true,
    });
    expect(currentCalls).toBe(1);
  });

  it('keeps SDK errors unavailable while allowing a failed last-known read to try current once', async () => {
    const fixture = sdkFor({
      getLastKnownPositionAsync: () => Promise.reject(new Error('native cache failed')),
      getCurrentPositionAsync: () => Promise.resolve(locationFor()),
    });

    await expect(
      createLocationService(fixture.sdk, { now: () => NOW }).acquire(),
    ).resolves.toMatchObject({
      status: 'available',
    });
    const unavailable = sdkFor({
      getLastKnownPositionAsync: () => Promise.resolve(null),
      getCurrentPositionAsync: () => Promise.reject(new Error('native fix failed')),
    });
    await expect(
      createLocationService(unavailable.sdk, { now: () => NOW }).acquire(),
    ).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('returns timeout distinctly and ignores a late native fix', async () => {
    vi.useFakeTimers();
    let resolveCurrent: ((location: LocationObject) => void) | undefined;
    let currentCalls = 0;
    const fixture = sdkFor({
      getLastKnownPositionAsync: () => Promise.resolve(null),
      getCurrentPositionAsync: () => {
        currentCalls += 1;
        return new Promise<LocationObject>((resolve) => {
          resolveCurrent = resolve;
        });
      },
    });
    const pending = createLocationService(fixture.sdk, { now: () => NOW }).acquire({
      timeoutMs: 10,
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({
      status: 'timeout',
      lat: null,
      lng: null,
    });
    resolveCurrent?.(locationFor());
    await flushMicrotasks();
    expect(currentCalls).toBe(1);
    expect(LOCATION_TIMEOUT_CAP_MS).toBeGreaterThan(10);
  });

  it('returns cancellation distinctly and blocks a late fix after abort', async () => {
    vi.useFakeTimers();
    let resolveCurrent: ((location: LocationObject) => void) | undefined;
    const fixture = sdkFor({
      getLastKnownPositionAsync: () => Promise.resolve(null),
      getCurrentPositionAsync: () =>
        new Promise<LocationObject>((resolve) => {
          resolveCurrent = resolve;
        }),
    });
    const controller = new AbortController();
    const pending = createLocationService(fixture.sdk, { now: () => NOW }).acquire({
      signal: controller.signal,
    });
    await flushMicrotasks();
    controller.abort();
    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    resolveCurrent?.(locationFor());
    await flushMicrotasks();
  });

  it('does not start a native permission request when aborted in the same tick', async () => {
    const fixture = sdkFor();
    const controller = new AbortController();
    const pending = createLocationService(fixture.sdk, { now: () => NOW }).acquire({
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expect(fixture.calls.foreground).toBe(0);
    expect(fixture.calls.requestForeground).toBe(0);
  });

  it('cancels a superseded attempt and accepts only the newer generation', async () => {
    let resolveFirst: ((location: LocationObject) => void) | undefined;
    let currentAttempt = 0;
    let resolveFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const first = sdkFor({
      getLastKnownPositionAsync: () => Promise.resolve(null),
      getCurrentPositionAsync: () => {
        resolveFirstStarted?.();
        return new Promise<LocationObject>((resolve) => {
          resolveFirst = resolve;
        });
      },
    });
    const second = sdkFor();
    const service = createLocationService(
      {
        ...first.sdk,
        getCurrentPositionAsync: () => {
          currentAttempt += 1;
          if (currentAttempt === 1) return first.sdk.getCurrentPositionAsync();
          return second.sdk.getCurrentPositionAsync();
        },
      },
      { now: () => NOW },
    );
    const oldAttempt = service.acquire();
    await firstStarted;
    expect(currentAttempt).toBe(1);
    const newAttempt = service.acquire();
    await expect(newAttempt).resolves.toMatchObject({ status: 'available' });
    resolveFirst?.(locationFor());
    await expect(oldAttempt).resolves.toEqual({ status: 'cancelled' });
  });

  it('rejects stale, future, invalid, and out-of-range native positions safely', async () => {
    const stale = sdkFor({
      getLastKnownPositionAsync: () =>
        Promise.resolve(locationFor({ ageMs: LOCATION_MAX_AGE_MS + 1 })),
      getCurrentPositionAsync: () =>
        Promise.resolve(locationFor({ ageMs: LOCATION_MAX_AGE_MS + 1 })),
    });
    await expect(
      createLocationService(stale.sdk, { now: () => NOW }).acquire(),
    ).resolves.toMatchObject({
      status: 'unavailable',
    });

    const invalid = sdkFor({
      getLastKnownPositionAsync: () => Promise.resolve(locationFor({ latitude: 91 })),
      getCurrentPositionAsync: () => Promise.resolve(locationFor({ timestamp: 8.64e15 + 1 })),
    });
    await expect(
      createLocationService(invalid.sdk, { now: () => NOW }).acquire(),
    ).resolves.toMatchObject({
      status: 'unavailable',
    });
  });
});
