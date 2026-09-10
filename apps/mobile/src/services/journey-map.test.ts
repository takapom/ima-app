import { describe, expect, it } from 'vitest';
import { buildAppleWalkingMapUrl } from './journey-map';

describe('Apple walking map service boundary', () => {
  it('builds the walking URL from supplied coordinates', () => {
    const result = buildAppleWalkingMapUrl({ latitude: 35.6467, longitude: 139.71 });

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
    expect(buildAppleWalkingMapUrl({ latitude: 91, longitude: 139 })).toEqual({
      status: 'unavailable',
      reason: 'destination_invalid',
    });
    expect(buildAppleWalkingMapUrl({ latitude: Number.NaN, longitude: 139 })).toEqual({
      status: 'unavailable',
      reason: 'destination_invalid',
    });
  });
});
