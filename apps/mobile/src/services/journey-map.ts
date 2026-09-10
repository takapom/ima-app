export type WalkingMapDestination = {
  readonly latitude: number;
  readonly longitude: number;
};

export type AppleWalkingMapResult =
  | { readonly status: 'ready'; readonly url: string }
  | {
      readonly status: 'unavailable';
      readonly reason: 'destination_missing' | 'destination_invalid';
    };

const isValidDestination = (destination: WalkingMapDestination): boolean =>
  Number.isFinite(destination.latitude) &&
  Number.isFinite(destination.longitude) &&
  destination.latitude >= -90 &&
  destination.latitude <= 90 &&
  destination.longitude >= -180 &&
  destination.longitude <= 180;

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

  const daddr = `${destination.latitude},${destination.longitude}`;
  return {
    status: 'ready',
    url: `https://maps.apple.com/?daddr=${encodeURIComponent(daddr)}&dirflg=w`,
  };
};
