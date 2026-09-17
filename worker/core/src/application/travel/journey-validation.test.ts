import { describe, expect, it } from 'vitest';
import type { JourneyRecord, JourneyServiceDateContext } from '@core/domain/journey';
import {
  classifyJourneyForServiceDate,
  validateJourneyForServiceDate,
  validateJourneyRecord,
} from '@core/application/travel/journey-validation';

const source = {
  provider: 'fixture',
  recordRef: 'journey-record-1',
  attribution: 'Fixture timetable',
  publicUrl: null,
};

const makeJourney = (overrides: Partial<JourneyRecord> = {}): JourneyRecord => ({
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

const makeContext = (
  overrides: Partial<JourneyServiceDateContext> = {},
): JourneyServiceDateContext => ({
  serviceDate: '2026-09-10',
  weekday: 'thursday',
  isHoliday: false,
  now: '2026-09-10T12:00:00Z',
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
  ...overrides,
});

describe('journey service-date validation', () => {
  it('accepts a fresh journey only when the weekday is derived consistently', () => {
    expect(validateJourneyForServiceDate(makeJourney(), makeContext())).toMatchObject({
      status: 'valid',
    });
    const wrongWeekday = validateJourneyForServiceDate(
      makeJourney(),
      makeContext({ weekday: 'friday' }),
    );
    expect(wrongWeekday).toMatchObject({ status: 'invalid' });
    if (wrongWeekday.status === 'invalid') {
      expect(wrongWeekday.issues[0]?.code).toBe('MISSING_CONTEXT');
    }
  });

  it('applies holiday and validity windows without treating a mismatch as known', () => {
    const holidayExcluded = validateJourneyForServiceDate(
      makeJourney({ servicePattern: { weekdays: ['thursday'], holidayPolicy: 'excluded' } }),
      makeContext({ isHoliday: true }),
    );
    expect(holidayExcluded).toMatchObject({ status: 'invalid' });
    expect(
      validateJourneyForServiceDate(makeJourney({ validThrough: '2026-09-09' }), makeContext()),
    ).toMatchObject({ status: 'invalid' });
    expect(
      validateJourneyRecord(makeJourney({ validThrough: '2026-09-09' }), '2026-09-10T12:00:00Z'),
    ).toMatchObject({ status: 'invalid', issues: [{ code: 'INVALID_EVIDENCE' }] });
    expect(
      validateJourneyForServiceDate(makeJourney({ serviceDate: '2026-09-11' }), makeContext()),
    ).toMatchObject({ status: 'invalid' });
  });

  it('uses an exclusive seven-day freshness boundary', () => {
    const justFresh = validateJourneyRecord(makeJourney(), '2026-09-11T11:59:59.999Z');
    expect(justFresh.status).toBe('valid');
    const exactlyStale = validateJourneyRecord(makeJourney(), '2026-09-11T12:00:00Z');
    expect(exactlyStale).toMatchObject({ status: 'invalid' });
    if (exactlyStale.status === 'invalid') {
      expect(exactlyStale.issues[0]?.code).toBe('STALE_EVIDENCE');
    }
  });

  it('classifies missing, same-station, invalid-context, and stale states explicitly', () => {
    expect(classifyJourneyForServiceDate(undefined, makeContext())).toMatchObject({
      status: 'disabled',
      reason: 'missing',
      walkingVerificationRequired: true,
    });
    expect(
      classifyJourneyForServiceDate(undefined, makeContext({ homeStationRef: 'station-a' })),
    ).toMatchObject({
      status: 'not_applicable',
      reason: 'same_station',
      walkingVerificationRequired: true,
    });
    expect(
      classifyJourneyForServiceDate(
        undefined,
        makeContext({ fromStationRef: '', homeStationRef: '' }),
      ),
    ).toMatchObject({ status: 'disabled', reason: 'invalid' });
    expect(
      classifyJourneyForServiceDate(
        undefined,
        makeContext({ homeStationRef: 'station-a', weekday: 'friday' }),
      ),
    ).toMatchObject({ status: 'disabled', reason: 'invalid' });
    expect(
      classifyJourneyForServiceDate(makeJourney(), makeContext({ now: '2026-09-11T12:00:00Z' })),
    ).toMatchObject({ status: 'disabled', reason: 'stale' });
  });
});
