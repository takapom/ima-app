import { describe, expect, it } from 'vitest';
import type { PublicCard } from '@ima/contracts';
import {
  buildAppleWalkingMapUrl,
  googleMapsSearchUrlFor,
  placePageUrlFor,
  resolveJourneyMapTarget,
  resolveMapHandoff,
} from '@mobile/journey/services/journey-map';

const retention = {
  retentionDecision: 'deny' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: '2026-09-10T00:00:00Z',
  freshUntil: '2026-09-10T00:00:00Z',
  displayUntil: '2026-09-10T00:00:00Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only' as const,
  policyStatus: 'policy_withheld' as const,
  displayPolicyStatus: 'available' as const,
};

const cardWith = (
  sourceUrl: string | null,
  displayPolicyStatus: 'available' | 'expired' = 'available',
): PublicCard => ({
  candidateId: 'candidate-1',
  facts: {
    identity: {
      status: 'known',
      value: {
        name: '夜カフェ',
        area: '恵比寿',
        address: '東京都渋谷区恵比寿1-1-1',
        category: 'cafe',
        stationName: null,
        accessText: null,
        businessStatus: 'operational',
        sourceUrl,
      },
      evidence: [
        {
          evidenceId: 'identity-1',
          attribution: null,
          retention: { ...retention, displayPolicyStatus },
        },
      ],
    },
  },
  why: {
    text: '静かに話せる',
    retention,
  },
});

const cardWithIdentity = (overrides: { readonly address: string | null }): PublicCard => {
  const card = cardWith('https://example.com/shop/1');
  const identity = card.facts.identity;
  if (identity.status !== 'known') throw new Error('fixture identity must be known');
  return {
    ...card,
    facts: { ...card.facts, identity: { ...identity, value: { ...identity.value, ...overrides } } },
  };
};

const unknownIdentityCard: PublicCard = {
  ...cardWith('https://example.com/shop/1'),
  facts: { identity: { status: 'unknown', reason: 'not_found' } },
};

const coordinates = {
  latitude: 35.6467,
  longitude: 139.71,
  mapsPolicy: 'allow' as const,
  provenance: 'user_provided' as const,
};

describe('Apple walking map service boundary', () => {
  it('builds the walking URL from supplied coordinates', () => {
    const result = buildAppleWalkingMapUrl({
      latitude: 35.6467,
      longitude: 139.71,
      mapsPolicy: 'allow',
      provenance: 'user_provided',
    });

    expect(result).toEqual({
      status: 'ready',
      url: 'https://maps.apple.com/?daddr=35.6467%2C139.71&dirflg=w',
    });
  });

  it('reports missing saved destination instead of guessing an address', () => {
    expect(buildAppleWalkingMapUrl(null)).toEqual({
      status: 'unavailable',
      reason: 'destination_missing',
    });
  });

  it('rejects invalid coordinates before constructing a URL', () => {
    expect(
      buildAppleWalkingMapUrl({
        latitude: 91,
        longitude: 139,
        mapsPolicy: 'allow',
        provenance: 'user_provided',
      }),
    ).toEqual({ status: 'unavailable', reason: 'destination_invalid' });
    expect(
      buildAppleWalkingMapUrl({
        latitude: Number.NaN,
        longitude: 139,
        mapsPolicy: 'allow',
        provenance: 'user_provided',
      }),
    ).toEqual({ status: 'unavailable', reason: 'destination_invalid' });
  });

  it('rejects Google Maps coordinates from an Apple Maps handoff', () => {
    expect(
      buildAppleWalkingMapUrl({
        latitude: 35.6467,
        longitude: 139.71,
        mapsPolicy: 'allow',
        provenance: 'google_places',
      }),
    ).toEqual({ status: 'unavailable', reason: 'policy_denied' });
    expect(
      buildAppleWalkingMapUrl({
        latitude: 35.6467,
        longitude: 139.71,
        mapsPolicy: 'unknown',
        provenance: 'unknown',
      }),
    ).toEqual({ status: 'unavailable', reason: 'policy_denied' });
  });

  it('allows coordinates with an explicit independent-source policy decision', () => {
    expect(
      buildAppleWalkingMapUrl({
        latitude: 35.6467,
        longitude: 139.71,
        mapsPolicy: 'allow',
        provenance: 'independent',
      }).status,
    ).toBe('ready');
  });
});

describe('place page fallback for a provider without coordinates', () => {
  it('takes the place page from displayable identity evidence only', () => {
    expect(placePageUrlFor(cardWith('https://example.com/shop/1'))).toBe(
      'https://example.com/shop/1',
    );
    expect(placePageUrlFor(cardWith(null))).toBeNull();
    expect(placePageUrlFor(cardWith('https://example.com/shop/1', 'expired'))).toBeNull();
  });

  it('prefers a trusted walking map over the place page', () => {
    expect(resolveJourneyMapTarget(coordinates, cardWith('https://example.com/shop/1'))).toEqual({
      status: 'ready',
      url: 'https://maps.apple.com/?daddr=35.6467%2C139.71&dirflg=w',
      target: 'map',
    });
  });

  it('falls back to the place page when coordinates are missing or policy denied', () => {
    expect(resolveJourneyMapTarget(null, cardWith('https://example.com/shop/1'))).toEqual({
      status: 'ready',
      url: 'https://example.com/shop/1',
      target: 'place_page',
    });
    expect(
      resolveJourneyMapTarget(
        { ...coordinates, provenance: 'google_places' },
        cardWith('https://example.com/shop/1'),
      ),
    ).toEqual({ status: 'ready', url: 'https://example.com/shop/1', target: 'place_page' });
  });

  it('keeps the coordinate failure reason when no place page is available', () => {
    expect(resolveJourneyMapTarget(null, cardWith(null))).toEqual({
      status: 'unavailable',
      reason: 'destination_missing',
    });
  });

  it('reports an invalid coordinate instead of hiding a resolver defect', () => {
    expect(
      resolveJourneyMapTarget(
        { ...coordinates, latitude: Number.NaN },
        cardWith('https://example.com/shop/1'),
      ),
    ).toEqual({ status: 'unavailable', reason: 'destination_invalid' });
  });

  it('refuses a place page URL that the source-link rules reject', () => {
    // The public schema accepts https URLs that still carry userinfo, and this value
    // is both opened natively and shared outside the app.
    expect(placePageUrlFor(cardWith('https://user:pass@example.com/shop/1'))).toBeNull();
    expect(resolveJourneyMapTarget(null, cardWith('https://user:pass@example.com/shop/1'))).toEqual(
      { status: 'unavailable', reason: 'destination_missing' },
    );
  });

  it('normalizes the place page URL through the shared source-link preparation', () => {
    expect(placePageUrlFor(cardWith('https://example.com'))).toBe('https://example.com/');
  });
});

describe('Google Maps search handoff', () => {
  it('builds a keyless Google Maps search URL from the displayable name and address', () => {
    expect(googleMapsSearchUrlFor(cardWith('https://example.com/shop/1'))).toBe(
      'https://www.google.com/maps/search/?api=1&query=%E5%A4%9C%E3%82%AB%E3%83%95%E3%82%A7%20%E6%9D%B1%E4%BA%AC%E9%83%BD%E6%B8%8B%E8%B0%B7%E5%8C%BA%E6%81%B5%E6%AF%94%E5%AF%BF1-1-1',
    );
  });

  it('falls back to the area when the address is not provided', () => {
    expect(googleMapsSearchUrlFor(cardWithIdentity({ address: null }))).toBe(
      'https://www.google.com/maps/search/?api=1&query=%E5%A4%9C%E3%82%AB%E3%83%95%E3%82%A7%20%E6%81%B5%E6%AF%94%E5%AF%BF',
    );
  });

  it('does not build a search from an unknown identity', () => {
    expect(googleMapsSearchUrlFor(unknownIdentityCard)).toBeNull();
  });

  it('does not hand expired provider identity to an external map', () => {
    expect(googleMapsSearchUrlFor(cardWith('https://example.com/shop/1', 'expired'))).toBeNull();
  });
});

describe('map handoff', () => {
  it('opens the Google Maps search even when trusted coordinates exist', () => {
    expect(resolveMapHandoff(coordinates, cardWith('https://example.com/shop/1'))).toEqual({
      status: 'ready',
      url: googleMapsSearchUrlFor(cardWith('https://example.com/shop/1')),
      target: 'map',
    });
  });

  it('falls back to trusted coordinates when the identity can no longer be shown', () => {
    expect(
      resolveMapHandoff(coordinates, cardWith('https://example.com/shop/1', 'expired')),
    ).toEqual({
      status: 'ready',
      url: 'https://maps.apple.com/?daddr=35.6467%2C139.71&dirflg=w',
      target: 'map',
    });
  });

  it('reports a missing destination instead of opening anything for an expired identity', () => {
    expect(resolveMapHandoff(null, cardWith('https://example.com/shop/1', 'expired'))).toEqual({
      status: 'unavailable',
      reason: 'destination_missing',
    });
  });
});
