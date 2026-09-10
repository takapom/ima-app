import { describe, expect, it } from 'vitest';
import type { LastTrainInfo } from '../domain/place-values';
import { recalculateLastTrainAtArrival } from './last-train-recalculation';

const info: LastTrainInfo = {
  serviceDate: '2026-09-10',
  fromStationRef: 'station-from',
  homeStationRef: 'station-home',
  journeyRef: 'journey-1',
  lastDepartureAt: '2026-09-10T23:00:00Z',
  arrivesHomeAt: '2026-09-10T23:30:00Z',
  transfers: [],
  placeToStationSeconds: 600,
  arrivePlaceAt: '2026-09-10T12:10:00Z',
  leaveBy: '2026-09-10T22:47:00Z',
  availableStaySeconds: 38_220,
  minimumStayMinutes: 20,
  usable: true,
};

describe('recalculateLastTrainAtArrival', () => {
  it('recomputes arrival and stay after the submit clock advances', () => {
    const oneMillisecond = recalculateLastTrainAtArrival({
      info,
      arrivalAt: '2026-09-10T12:10:00.001Z',
      earliestStoredArrivalAt: '2026-09-10T12:10:00Z',
      minimumStayMinutes: 20,
    });
    expect(oneMillisecond).toMatchObject({ status: 'ok' });
    if (oneMillisecond.status === 'ok') {
      expect(oneMillisecond.data.arrivePlaceAt).toBe('2026-09-10T12:10:00.001Z');
      expect(oneMillisecond.data.availableStaySeconds).toBe(38_219);
      expect(oneMillisecond.data.usable).toBe(true);
    }

    const severalSeconds = recalculateLastTrainAtArrival({
      info,
      arrivalAt: '2026-09-10T12:10:05Z',
      earliestStoredArrivalAt: '2026-09-10T12:10:00Z',
      minimumStayMinutes: 20,
    });
    expect(severalSeconds).toMatchObject({
      status: 'ok',
      data: { availableStaySeconds: 38_215, usable: true },
    });

    const generatedAfterWalkingEvaluation = recalculateLastTrainAtArrival({
      info: {
        ...info,
        arrivePlaceAt: '2026-09-10T12:10:05Z',
        availableStaySeconds: 38_215,
      },
      arrivalAt: '2026-09-10T12:10:05Z',
      earliestStoredArrivalAt: '2026-09-10T12:10:00Z',
      minimumStayMinutes: 20,
    });
    expect(generatedAfterWalkingEvaluation).toMatchObject({
      status: 'ok',
      data: { arrivePlaceAt: '2026-09-10T12:10:05.000Z', availableStaySeconds: 38_215 },
    });
  });

  it('rejects a tampered stored leave-by or stay arithmetic', () => {
    const badLeaveBy = recalculateLastTrainAtArrival({
      info: { ...info, leaveBy: '2026-09-10T22:46:00Z' },
      arrivalAt: '2026-09-10T12:10:00.001Z',
      earliestStoredArrivalAt: '2026-09-10T12:10:00Z',
      minimumStayMinutes: 20,
    });
    expect(badLeaveBy).toMatchObject({ status: 'error', error: { path: 'last_train.leaveBy' } });

    const badHomeArrival = recalculateLastTrainAtArrival({
      info: { ...info, arrivesHomeAt: '2026-09-10T22:00:00Z' },
      arrivalAt: '2026-09-10T12:10:00.001Z',
      earliestStoredArrivalAt: '2026-09-10T12:10:00Z',
      minimumStayMinutes: 20,
    });
    expect(badHomeArrival).toMatchObject({
      status: 'error',
      error: { path: 'last_train.arrivesHomeAt' },
    });

    const badStay = recalculateLastTrainAtArrival({
      info: { ...info, availableStaySeconds: 1, usable: false },
      arrivalAt: '2026-09-10T12:10:00.001Z',
      earliestStoredArrivalAt: '2026-09-10T12:10:00Z',
      minimumStayMinutes: 20,
    });
    expect(badStay).toMatchObject({
      status: 'error',
      error: { path: 'last_train.availableStaySeconds' },
    });

    const badArrival = recalculateLastTrainAtArrival({
      info: {
        ...info,
        arrivePlaceAt: '2026-09-10T12:09:00Z',
        availableStaySeconds: 38_280,
      },
      arrivalAt: '2026-09-10T12:10:00.001Z',
      earliestStoredArrivalAt: '2026-09-10T12:10:00Z',
      minimumStayMinutes: 20,
    });
    expect(badArrival).toMatchObject({
      status: 'error',
      error: { path: 'last_train.arrivePlaceAt' },
    });
  });
});
