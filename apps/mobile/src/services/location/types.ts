import type { LocationSnapshot } from '@ima/contracts';
import type { LocationObject, LocationPermissionResponse } from 'expo-location';

export type LocationAcquireOptions = {
  /** A hook-owned signal; aborting it must never return a native fix. */
  readonly signal?: AbortSignal;
  /** Per-attempt deadline. The service caps this value to its bounded maximum. */
  readonly timeoutMs?: number;
};

export type LocationServiceOptions = {
  /** Clock used for deadlines, freshness, and the snapshot capture boundary. */
  readonly now?: () => number;
  /** Default deadline for an explicit acquisition attempt. */
  readonly timeoutMs?: number;
  /** Maximum age accepted from the one-shot last-known position. */
  readonly maxAgeMs?: number;
  /** Accuracy radius at or below which a fix may be marked precise. */
  readonly preciseAccuracyMeters?: number;
};

export type LocationCancellation = {
  readonly status: 'cancelled';
};

/**
 * A normal result is the public contract snapshot. Cancellation is a control
 * result because LocationSnapshot intentionally has no fabricated coordinates
 * or a cancellation status.
 */
export type LocationAcquireResult = LocationSnapshot | LocationCancellation;

/**
 * The narrow native port used by the location service. The adapter translates
 * the semantic options to expo-location, keeping SDK calls outside the policy.
 */
export type ExpoLocationSdk = {
  readonly getForegroundPermissionsAsync: () => Promise<LocationPermissionResponse>;
  readonly requestForegroundPermissionsAsync: () => Promise<LocationPermissionResponse>;
  readonly hasServicesEnabledAsync: () => Promise<boolean>;
  readonly getLastKnownPositionAsync: (maxAgeMs: number) => Promise<LocationObject | null>;
  readonly getCurrentPositionAsync: () => Promise<LocationObject>;
};

export type LocationService = {
  /** Called by an explicit send attempt; construction has no native side effects. */
  readonly acquire: (options?: LocationAcquireOptions) => Promise<LocationAcquireResult>;
};
