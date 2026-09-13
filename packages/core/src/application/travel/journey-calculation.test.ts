import { describe, expect, it } from 'vitest';
import type { JourneyRecord } from '../../domain/journey';
import { calculateJourneyTiming } from './journey-calculation';

const journey: JourneyRecord = {
  journeyRef: 'journey-1',
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
  serviceDate: '2026-09-10',
  servicePattern: { weekdays: ['thursday'], holidayPolicy: 'allowed' },
  lastDepartureAt: '2026-09-10T23:00:00+09:00',
  arrivesHomeAt: '2026-09-10T23:30:00+09:00',
  transfers: [],
  validFrom: '2026-09-01',
  validThrough: '2026-09-30',
  verifiedAt: '2026-09-10T10:00:00Z',
  source: {
    provider: 'fixture',
    recordRef: 'journey-record-1',
    attribution: 'Fixture timetable',
    publicUrl: null,
  },
};

const input = (overrides: Record<string, unknown> = {}) => ({
  journey,
  evaluatedAt: '2026-09-10T12:00:00.123Z',
  userToPlaceSeconds: 600,
  placeToStationSeconds: 600,
  minimumStayMinutes: 20,
  closedAt: null,
  lastOrderAt: null,
  ...overrides,
});

describe('journey timing calculation', () => {
  it('keeps last-order and last-train exit independent and floors available stay', () => {
    const result = calculateJourneyTiming(
      input({ closedAt: '2026-09-10T12:30:00.999Z', lastOrderAt: '2026-09-10T12:05:00Z' }),
    );
    expect(result).toMatchObject({ status: 'ok' });
    if (result.status === 'ok') {
      expect(result.data.arrivePlaceAt).toBe('2026-09-10T12:10:00.123Z');
      expect(result.data.leaveBy).toBe('2026-09-10T13:47:00.000Z');
      expect(result.data.stayDeadlineAt).toBe('2026-09-10T12:30:00.999Z');
      expect(result.data.availableStaySeconds).toBe(5819);
      expect(result.data.availableStayUntilClosingSeconds).toBe(1200);
      expect(result.data.orderableAtArrival).toBe(false);
      expect(result.data.usable).toBe(true);
    }
  });

  it('uses the earlier close or last-train exit and rejects an insufficient stay', () => {
    const short = calculateJourneyTiming(input({ closedAt: '2026-09-10T12:29:59.999Z' }));
    expect(short).toMatchObject({ status: 'ok' });
    if (short.status === 'ok') {
      expect(short.data.availableStaySeconds).toBe(5819);
      expect(short.data.availableStayUntilClosingSeconds).toBe(1199);
      expect(short.data.usable).toBe(true);
    }
    const noClose = calculateJourneyTiming(input());
    expect(noClose).toMatchObject({ status: 'ok' });
    if (noClose.status === 'ok') {
      expect(noClose.data.stayDeadlineAt).toBe('2026-09-10T13:47:00.000Z');
      expect(noClose.data.availableStaySeconds).toBe(5819);
      expect(noClose.data.orderableAtArrival).toBe(null);
    }
  });

  it('returns an unusable result for a negative stay and a structured error for unsafe durations', () => {
    const alreadyLate = calculateJourneyTiming(input({ evaluatedAt: '2026-09-10T22:50:00Z' }));
    expect(alreadyLate).toMatchObject({ status: 'ok' });
    if (alreadyLate.status === 'ok') {
      expect(alreadyLate.data.availableStaySeconds).toBe(-33180);
      expect(alreadyLate.data.usable).toBe(false);
    }
    expect(
      calculateJourneyTiming(input({ userToPlaceSeconds: Number.MAX_SAFE_INTEGER })),
    ).toMatchObject({ status: 'error', error: { code: 'INVALID_EVIDENCE' } });
  });
});
