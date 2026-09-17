import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  JourneyRecordSchema,
  JourneyServiceDateContextSchema,
  weekdayForCalendarDate,
} from '@core/domain/journey';

const source = {
  provider: 'fixture',
  recordRef: 'journey-record-1',
  attribution: 'Fixture timetable',
  publicUrl: null,
};

const makeJourney = (overrides: Record<string, unknown> = {}) => ({
  journeyRef: 'journey-1',
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
  serviceDate: '2026-09-10',
  servicePattern: { weekdays: ['thursday'], holidayPolicy: 'allowed' },
  lastDepartureAt: '2026-09-10T23:50:00+09:00',
  arrivesHomeAt: '2026-09-11T00:30:00+09:00',
  transfers: [],
  validFrom: '2026-09-01',
  validThrough: '2026-09-30',
  verifiedAt: '2026-09-04T12:00:00Z',
  source,
  ...overrides,
});

describe('journey domain contract', () => {
  it('derives the weekday without using the host timezone and permits one service-date rollover', () => {
    expect(weekdayForCalendarDate('2026-09-10')).toBe('thursday');
    expect(weekdayForCalendarDate('0001-01-01')).toBe('monday');
    expect(v.safeParse(JourneyRecordSchema, makeJourney()).success).toBe(true);
    expect(
      v.safeParse(
        JourneyRecordSchema,
        makeJourney({
          lastDepartureAt: '2026-09-10T14:50:00Z',
          arrivesHomeAt: '2026-09-10T15:30:00Z',
        }),
      ).success,
    ).toBe(true);
    expect(
      v.safeParse(JourneyRecordSchema, makeJourney({ arrivesHomeAt: '2026-09-12T00:30:00Z' }))
        .success,
    ).toBe(false);
  });

  it('requires transfer order and a connected station chain ending at home', () => {
    const transfers = [
      {
        fromStationRef: 'station-a',
        toStationRef: 'station-mid',
        departureAt: '2026-09-10T23:50:00+09:00',
        arrivalAt: '2026-09-11T00:00:00+09:00',
      },
      {
        fromStationRef: 'station-mid',
        toStationRef: 'station-b',
        departureAt: '2026-09-11T00:05:00+09:00',
        arrivalAt: '2026-09-11T00:30:00+09:00',
      },
    ];
    expect(v.safeParse(JourneyRecordSchema, makeJourney({ transfers })).success).toBe(true);
    expect(
      v.safeParse(
        JourneyRecordSchema,
        makeJourney({
          transfers: [{ ...transfers[0], fromStationRef: 'station-other' }, transfers[1]],
        }),
      ).success,
    ).toBe(false);
    expect(
      v.safeParse(
        JourneyRecordSchema,
        makeJourney({
          transfers: [{ ...transfers[0], toStationRef: 'station-other' }, transfers[1]],
        }),
      ).success,
    ).toBe(false);
    expect(
      v.safeParse(
        JourneyRecordSchema,
        makeJourney({ arrivesHomeAt: '2026-09-11T00:31:00+09:00', transfers }),
      ).success,
    ).toBe(false);
  });

  it('rejects empty station context before same-station classification can apply', () => {
    expect(
      v.safeParse(JourneyServiceDateContextSchema, {
        serviceDate: '2026-09-10',
        weekday: 'thursday',
        isHoliday: false,
        now: '2026-09-10T12:00:00Z',
        fromStationRef: '',
        homeStationRef: '',
      }).success,
    ).toBe(false);
  });
});
