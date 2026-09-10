import type { PublicCard } from '@ima/contracts';

export type WalkingMapDestination = {
  readonly latitude: number;
  readonly longitude: number;
  /** Provider-policy decision for sending this coordinate to Apple Maps. */
  readonly mapsPolicy: 'allow' | 'deny' | 'unknown';
  readonly provenance: 'user_provided' | 'independent' | 'google_places' | 'unknown';
};

export type AppleWalkingMapResult =
  | { readonly status: 'ready'; readonly url: string }
  | {
      readonly status: 'unavailable';
      readonly reason: 'destination_missing' | 'destination_invalid' | 'policy_denied';
    };

export type JourneyMapOpenResult =
  | { readonly status: 'opened' }
  | {
      readonly status: 'unavailable';
      readonly reason:
        'destination_missing' | 'destination_invalid' | 'policy_denied' | 'link_unavailable';
    }
  | { readonly status: 'failed'; readonly reason: 'native_unavailable' };

export type JourneyMapService = {
  readonly openWalkingMap: (card: PublicCard) => Promise<JourneyMapOpenResult>;
};

export type WalkingMapDestinationResolver = (card: PublicCard) => WalkingMapDestination | null;

const isValidDestination = (destination: WalkingMapDestination): boolean =>
  Number.isFinite(destination.latitude) &&
  Number.isFinite(destination.longitude) &&
  destination.latitude >= -90 &&
  destination.latitude <= 90 &&
  destination.longitude >= -180 &&
  destination.longitude <= 180;

const isAllowedForAppleMaps = (destination: WalkingMapDestination): boolean =>
  destination.mapsPolicy === 'allow' &&
  (destination.provenance === 'user_provided' || destination.provenance === 'independent');

/**
 * Build the documented Apple Maps walking URL from coordinates already supplied
 * by a trusted details/saved-place boundary. This function does not geocode.
 */
export const buildAppleWalkingMapUrl = (
  destination: WalkingMapDestination | null,
): AppleWalkingMapResult => {
  if (destination === null) {
    return { status: 'unavailable', reason: 'destination_missing' };
  }
  if (!isValidDestination(destination)) {
    return { status: 'unavailable', reason: 'destination_invalid' };
  }
  if (!isAllowedForAppleMaps(destination)) {
    return { status: 'unavailable', reason: 'policy_denied' };
  }

  const daddr = `${destination.latitude},${destination.longitude}`;
  return {
    status: 'ready',
    url: `https://maps.apple.com/?daddr=${encodeURIComponent(daddr)}&dirflg=w`,
  };
};
