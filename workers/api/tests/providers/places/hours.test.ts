import { describe, expect, it } from 'vitest';
import type { OpeningHours } from '@ima/core';
import { normalizeGoogleOpeningHours } from '../../../src/providers/places/hours';
import { parseGooglePlaceWire, type GooglePlaceWire } from '../../../src/providers/places/wire';

const EVALUATED_AT = '2026-09-10T00:00:00Z';

const point = (
  year: number,
  month: number,
  day: number,
  hour?: number,
  minute?: number,
  options: { readonly truncated?: boolean; readonly dayOfWeek?: number } = {},
) => ({
  date: { year, month, day },
  ...(hour === undefined ? {} : { hour }),
  ...(minute === undefined ? {} : { minute }),
  ...(options.truncated === undefined ? {} : { truncated: options.truncated }),
  ...(options.dayOfWeek === undefined ? {} : { day: options.dayOfWeek }),
});

const place = (overrides: Record<string, unknown> = {}): GooglePlaceWire =>
  parseGooglePlaceWire({
    id: 'ChIJ-hours-fixture',
    name: 'places/hours-fixture',
    timeZone: { id: 'Asia/Tokyo' },
    ...overrides,
  });

type HoursResult = ReturnType<typeof normalizeGoogleOpeningHours>;

const knownHours = (result: HoursResult): OpeningHours => {
  expect(result.status).toBe('known');
  if (result.status !== 'known') throw new Error('opening hours should be known');
  return result.value;
};

const expectUnknown = (result: HoursResult): void => {
  expect(result.status).toBe('unknown');
  if (result.status !== 'unknown') throw new Error('opening hours should be unknown');
};

const expectError = (result: HoursResult, code: 'SCHEMA_MISMATCH' | 'SOURCE_CONFLICT'): void => {
  expect(result.status).toBe('error');
  if (result.status !== 'error') throw new Error('opening hours should be an error');
  expect(result.code).toBe(code);
};

describe('Google Places opening-hours normalization', () => {
  it('converts dated local periods to absolute RFC3339 intervals and preserves weekly order', () => {
    const result = normalizeGoogleOpeningHours(
      place({
        regularOpeningHours: {
          weekdayDescriptions: ['Mon: 10:00–18:00', 'Sun: 10:00–16:00'],
        },
        currentOpeningHours: {
          periods: [
            {
              open: point(2026, 9, 10, 22, 0),
              close: point(2026, 9, 11, 2, 0),
            },
            {
              open: point(2026, 9, 10, 10, 0),
              close: point(2026, 9, 10, 18, 0),
            },
          ],
          weekdayDescriptions: ['special Thursday text'],
          specialDays: [{ date: { year: 2026, month: 9, day: 10 } }],
          openNow: false,
          nextOpenTime: '2026-09-10T01:00:00Z',
        },
      }),
      { evaluatedAt: EVALUATED_AT },
    );
    const value = knownHours(result);
    expect(value.timeZone).toBe('Asia/Tokyo');
    expect(value.intervals).toEqual([
      { startAt: '2026-09-10T01:00:00.000Z', endAt: '2026-09-10T09:00:00.000Z' },
      { startAt: '2026-09-10T13:00:00.000Z', endAt: '2026-09-10T17:00:00.000Z' },
    ]);
    expect(value.weeklyText).toEqual(['Mon: 10:00–18:00', 'Sun: 10:00–16:00']);
    expect(value.listedOpenAtEvaluation).toBe(false);
    expect(value.nextBoundaryAt).toBe('2026-09-10T01:00:00.000Z');
    expect(value.lastOrderAt).toBeNull();
    expect(value.lastOrderRaw).toBeNull();
  });

  it('supports the official 24-hour point with omitted date and close', () => {
    const value = knownHours(
      normalizeGoogleOpeningHours(
        place({
          timeZone: { id: 'Asia/Tokyo' },
          currentOpeningHours: {
            periods: [{ open: {} }],
            openNow: true,
          },
        }),
        { evaluatedAt: '2026-09-10T00:00:00Z' },
      ),
    );
    expect(value.intervals).toEqual([{ startAt: '2026-09-09T15:00:00.000Z', endAt: null }]);
    expect(value.nextBoundaryAt).toBeNull();

    const dated = knownHours(
      normalizeGoogleOpeningHours(
        place({
          currentOpeningHours: {
            periods: [{ open: point(2026, 9, 13, 0, 0, { dayOfWeek: 0 }) }],
            openNow: true,
          },
        }),
        { evaluatedAt: '2026-09-13T00:00:00Z' },
      ),
    );
    expect(dated.intervals).toEqual([{ startAt: '2026-09-12T15:00:00.000Z', endAt: null }]);
  });

  it('does not treat a non-Sunday missing close as an always-open marker', () => {
    const result = normalizeGoogleOpeningHours(
      place({
        currentOpeningHours: {
          periods: [{ open: point(2026, 9, 10, 0, 0, { dayOfWeek: 4 }) }],
        },
      }),
      { evaluatedAt: EVALUATED_AT },
    );
    expectUnknown(result);
  });

  it('accepts a truncated opening edge but withholds a truncated closing edge', () => {
    const clippedOpen = normalizeGoogleOpeningHours(
      place({
        currentOpeningHours: {
          periods: [
            {
              open: point(2026, 9, 10, 0, 0, { truncated: true }),
              close: point(2026, 9, 10, 6, 0),
            },
          ],
          openNow: true,
          nextCloseTime: '2026-09-09T21:00:00Z',
        },
      }),
      { evaluatedAt: '2026-09-09T15:00:00Z' },
    );
    expect(knownHours(clippedOpen).intervals).toEqual([
      { startAt: '2026-09-09T15:00:00.000Z', endAt: '2026-09-09T21:00:00.000Z' },
    ]);

    const clippedClose = normalizeGoogleOpeningHours(
      place({
        currentOpeningHours: {
          periods: [
            {
              open: point(2026, 9, 10, 22, 0),
              close: point(2026, 9, 11, 0, 0, { truncated: true }),
            },
          ],
        },
      }),
      { evaluatedAt: EVALUATED_AT },
    );
    expectUnknown(clippedClose);
  });

  it('treats an empty current period list as a known never-open window', () => {
    const value = knownHours(
      normalizeGoogleOpeningHours(place({ currentOpeningHours: { periods: [], openNow: false } }), {
        evaluatedAt: EVALUATED_AT,
      }),
    );
    expect(value.intervals).toEqual([]);
    expect(value.listedOpenAtEvaluation).toBe(false);
  });

  it('distinguishes missing and invalid IANA time zones from valid data', () => {
    const missing = normalizeGoogleOpeningHours(
      parseGooglePlaceWire({ currentOpeningHours: { periods: [] } }),
      { evaluatedAt: EVALUATED_AT },
    );
    expectUnknown(missing);

    const invalid = normalizeGoogleOpeningHours(
      place({
        timeZone: { id: 'Mars/Phobos' },
        currentOpeningHours: { periods: [] },
      }),
      { evaluatedAt: EVALUATED_AT },
    );
    expectError(invalid, 'SCHEMA_MISMATCH');
  });

  it('withholds ambiguous and nonexistent local wall times at DST transitions', () => {
    const nonexistent = normalizeGoogleOpeningHours(
      place({
        timeZone: { id: 'America/New_York' },
        currentOpeningHours: {
          periods: [
            {
              open: point(2026, 3, 8, 2, 30),
              close: point(2026, 3, 8, 4, 0),
            },
          ],
        },
      }),
      { evaluatedAt: '2026-03-08T05:00:00Z' },
    );
    expectUnknown(nonexistent);

    const ambiguous = normalizeGoogleOpeningHours(
      place({
        timeZone: { id: 'America/New_York' },
        currentOpeningHours: {
          periods: [
            {
              open: point(2026, 11, 1, 1, 30),
              close: point(2026, 11, 1, 3, 0),
            },
          ],
        },
      }),
      { evaluatedAt: '2026-11-01T04:00:00Z' },
    );
    expectUnknown(ambiguous);
  });

  it('rejects contradictory or stale openNow boundary metadata', () => {
    const emptyActive = normalizeGoogleOpeningHours(
      place({
        currentOpeningHours: {
          periods: [],
          openNow: true,
        },
      }),
      { evaluatedAt: EVALUATED_AT },
    );
    expectError(emptyActive, 'SOURCE_CONFLICT');

    const emptyWithNextOpen = normalizeGoogleOpeningHours(
      place({
        currentOpeningHours: {
          periods: [],
          openNow: false,
          nextOpenTime: '2026-09-10T03:00:00Z',
        },
      }),
      { evaluatedAt: EVALUATED_AT },
    );
    expectError(emptyWithNextOpen, 'SOURCE_CONFLICT');

    const activeWithOpenBoundary = normalizeGoogleOpeningHours(
      place({
        currentOpeningHours: {
          periods: [],
          openNow: true,
          nextOpenTime: '2026-09-10T03:00:00Z',
        },
      }),
      { evaluatedAt: EVALUATED_AT },
    );
    expectError(activeWithOpenBoundary, 'SOURCE_CONFLICT');

    const inactiveWithCloseBoundary = normalizeGoogleOpeningHours(
      place({
        currentOpeningHours: {
          periods: [],
          openNow: false,
          nextCloseTime: '2026-09-10T03:00:00Z',
        },
      }),
      { evaluatedAt: EVALUATED_AT },
    );
    expectError(inactiveWithCloseBoundary, 'SOURCE_CONFLICT');

    const closeAfterActivePeriod = normalizeGoogleOpeningHours(
      place({
        currentOpeningHours: {
          periods: [
            {
              open: point(2026, 9, 10, 10, 0),
              close: point(2026, 9, 10, 12, 0),
            },
          ],
          openNow: true,
          nextCloseTime: '2026-09-10T04:00:00Z',
        },
      }),
      { evaluatedAt: '2026-09-10T02:00:00Z' },
    );
    expectError(closeAfterActivePeriod, 'SOURCE_CONFLICT');

    const missingCloseBoundary = normalizeGoogleOpeningHours(
      place({
        currentOpeningHours: {
          periods: [
            {
              open: point(2026, 9, 10, 10, 0),
              close: point(2026, 9, 10, 12, 0),
            },
          ],
          openNow: true,
        },
      }),
      { evaluatedAt: '2026-09-10T02:00:00Z' },
    );
    expect(knownHours(missingCloseBoundary).nextBoundaryAt).toBeNull();

    const nextOpenAfterFirstPeriod = normalizeGoogleOpeningHours(
      place({
        currentOpeningHours: {
          periods: [
            {
              open: point(2026, 9, 10, 10, 0),
              close: point(2026, 9, 10, 12, 0),
            },
          ],
          openNow: false,
          nextOpenTime: '2026-09-10T03:00:00Z',
        },
      }),
      { evaluatedAt: EVALUATED_AT },
    );
    expectError(nextOpenAfterFirstPeriod, 'SOURCE_CONFLICT');

    const staleBoundary = normalizeGoogleOpeningHours(
      place({
        currentOpeningHours: {
          periods: [],
          openNow: false,
          nextOpenTime: '2026-09-09T23:59:59Z',
        },
      }),
      { evaluatedAt: EVALUATED_AT },
    );
    expectError(staleBoundary, 'SOURCE_CONFLICT');
  });

  it('does not invent a period when a non-24-hour date is absent', () => {
    const result = normalizeGoogleOpeningHours(
      place({
        currentOpeningHours: {
          periods: [
            {
              open: { hour: 9, minute: 0 },
              close: point(2026, 9, 10, 18, 0),
            },
          ],
        },
      }),
      { evaluatedAt: EVALUATED_AT },
    );
    expectUnknown(result);
  });
});
