import { describe, expect, it } from 'vitest';
import {
  WALKING_LOCATION_MAX_AGE_MS,
  distanceBetweenWalkingCoordinatesMeters,
  validateWalkingLocation,
} from '../walking-route-policy';

const now = '2026-09-10T09:00:00.000Z';
const originCoordinates = { lat: 35.6595, lng: 139.7005 };

const availableLocation = (overrides: Record<string, unknown> = {}) => ({
  status: 'available',
  coordinates: originCoordinates,
  accuracyMeters: 50,
  precise: true,
  capturedAt: '2026-09-10T08:59:00.000Z',
  revision: 2,
  ...overrides,
});

const validate = (location: unknown, overrides: Record<string, unknown> = {}) =>
  validateWalkingLocation({
    location,
    now,
    expectedRevision: 2,
    originCoordinates,
    ...overrides,
  });

describe('walking location policy', () => {
  it('accepts a precise location captured within two minutes and the expected revision', () => {
    expect(validate(availableLocation())).toMatchObject({
      status: 'valid',
      revision: 2,
      coordinates: originCoordinates,
    });
    expect(
      validate(
        availableLocation({
          capturedAt: new Date(Date.parse(now) - WALKING_LOCATION_MAX_AGE_MS).toISOString(),
        }),
      ).status,
    ).toBe('valid');
  });

  it('requires usable coordinates instead of falling back for denied or unavailable location', () => {
    for (const status of ['denied', 'timeout', 'unavailable']) {
      expect(
        validate({
          status,
          coordinates: null,
          accuracyMeters: null,
          precise: false,
          capturedAt: null,
          revision: 2,
        }),
      ).toMatchObject({ status: 'invalid', issue: { code: 'LOCATION_REQUIRED' } });
    }
    expect(validate(availableLocation({ status: 'reduced', precise: false }))).toMatchObject({
      status: 'invalid',
      issue: { code: 'LOCATION_IMPRECISE' },
    });
  });

  it('rejects inaccurate, old, future, and moved locations', () => {
    expect(validate(availableLocation({ accuracyMeters: 100.01 }))).toMatchObject({
      status: 'invalid',
      issue: { code: 'LOCATION_IMPRECISE' },
    });
    expect(validate(availableLocation({ precise: false }))).toMatchObject({
      status: 'invalid',
      issue: { code: 'LOCATION_IMPRECISE' },
    });
    expect(validate(availableLocation({ capturedAt: '2026-09-10T08:57:59.999Z' }))).toMatchObject({
      status: 'invalid',
      issue: { code: 'LOCATION_IMPRECISE' },
    });
    expect(validate(availableLocation({ capturedAt: '2026-09-10T09:00:00.001Z' }))).toMatchObject({
      status: 'invalid',
      issue: { code: 'LOCATION_IMPRECISE' },
    });
    expect(
      validate(availableLocation({ coordinates: { lat: 35.661, lng: 139.7005 } })),
    ).toMatchObject({
      status: 'invalid',
      issue: { code: 'LOCATION_IMPRECISE' },
    });
  });

  it('rejects a stale location revision before a route request', () => {
    expect(validate(availableLocation(), { expectedRevision: 3 })).toMatchObject({
      status: 'invalid',
      issue: { code: 'STALE_TURN' },
    });
  });

  it('clamps haversine rounding and never returns a non-finite invalidation distance', () => {
    const distance = distanceBetweenWalkingCoordinatesMeters(
      { lat: 90, lng: 0 },
      { lat: -90, lng: 180 },
    );
    expect(Number.isFinite(distance)).toBe(true);
    expect(distance).toBeGreaterThan(12_000_000);
  });
});
