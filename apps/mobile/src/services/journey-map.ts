import type { PublicCard } from '@ima/contracts';
import { prepareSourceLink } from './journey-source-link';

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

/** `place_page` means the provider's own page was opened instead of a walking map. */
export type JourneyMapTarget = 'map' | 'place_page';

export type JourneyMapOpenResult =
  | { readonly status: 'opened'; readonly target: JourneyMapTarget }
  | {
      readonly status: 'unavailable';
      readonly reason:
        'destination_missing' | 'destination_invalid' | 'policy_denied' | 'link_unavailable';
    }
  | { readonly status: 'failed'; readonly reason: 'native_unavailable' };

export type JourneyMapTargetResult =
  | { readonly status: 'ready'; readonly url: string; readonly target: JourneyMapTarget }
  | Extract<AppleWalkingMapResult, { readonly status: 'unavailable' }>;

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

/**
 * The provider's own place page, taken from identity evidence so retention and
 * attribution travel with the link. This module never geocodes a name or address.
 * The URL passes the same preparation as any other source link: the public schema
 * accepts an https URL that still carries userinfo, and this value is both opened
 * natively and shared outside the app.
 */
export const placePageUrlFor = (card: PublicCard): string | null => {
  const field = card.facts.identity;
  if (field.status !== 'known' || field.value.sourceUrl === null) return null;
  if (!field.evidence.every((item) => item.retention.displayPolicyStatus === 'available')) {
    return null;
  }
  const prepared = prepareSourceLink(field.value.sourceUrl);
  return prepared.status === 'ready' ? prepared.url : null;
};

/**
 * Prefers a walking map built from trusted coordinates and falls back to the place
 * page, so a provider that withholds coordinates still leaves a usable destination.
 * An invalid coordinate is a resolver defect rather than a missing capability, so it
 * is reported instead of being hidden behind the fallback.
 */
export const resolveJourneyMapTarget = (
  destination: WalkingMapDestination | null,
  card: PublicCard,
): JourneyMapTargetResult => {
  const map = buildAppleWalkingMapUrl(destination);
  if (map.status === 'ready') return { status: 'ready', url: map.url, target: 'map' };
  if (map.reason === 'destination_invalid') return map;
  const placePage = placePageUrlFor(card);
  return placePage === null ? map : { status: 'ready', url: placePage, target: 'place_page' };
};
