import type { LastTrainInfo } from '@ima/core';
import { describe, expect, it } from 'vitest';
import { createLastTrainObservationRegistrar } from '../../../src/providers/last-train/registration';
import { context, makeFixture, retention, SCOPE } from '../hot-pepper/adapter-fixtures';

const value: LastTrainInfo = {
  serviceDate: '2026-09-10',
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
  journeyRef: 'journey-registration-1',
  lastDepartureAt: '2026-09-10T23:50:00+09:00',
  arrivesHomeAt: '2026-09-11T00:30:00+09:00',
  transfers: [],
  placeToStationSeconds: 180,
  arrivePlaceAt: '2026-09-10T23:40:00+09:00',
  leaveBy: '2026-09-10T23:47:00+09:00',
  availableStaySeconds: 9_240,
  minimumStayMinutes: 20,
  usable: true,
};

describe('M14 last-train observation registration', () => {
  it('caps freshness at the validated last departure before policy expiry', () => {
    const fixture = makeFixture();
    const candidateId = fixture.candidateIds[0] ?? '';
    const future = '2026-09-30T00:00:00.000Z';
    const registrar = createLastTrainObservationRegistrar({
      registry: fixture.registry,
      clock: fixture.clock,
      currentOriginRef: 'current-location',
      observationPolicy: () => ({
        freshUntil: future,
        expiresAt: future,
        retention: {
          ...retention,
          sessionExpiresAt: future,
          freshUntil: future,
          displayUntil: future,
          retentionUntil: future,
          deletionScheduledAt: future,
        },
      }),
    });

    const result = registrar.register(candidateId, value, context, {
      source: {
        provider: 'fixture-railway',
        recordRef: 'timetable-registration-1',
        attribution: 'Fixture timetable',
        publicUrl: 'https://example.com/timetable-registration-1',
      },
      verifiedAt: '2026-09-05T12:00:00Z',
    });

    expect(result.status).toBe('known');
    expect(fixture.registry.listObservations(SCOPE, candidateId)[0]?.expiresAt).toBe(
      '2026-09-10T14:50:00.000Z',
    );
  });
});
