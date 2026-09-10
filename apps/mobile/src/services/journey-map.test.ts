import { describe, expect, it } from 'vitest';
import { buildAppleWalkingMapUrl } from './journey-map';

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
