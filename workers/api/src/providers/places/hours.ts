import * as v from 'valibot';
import { IsoTimestampSchema, OpeningHoursSchema, type OpeningHours } from '@ima/core';
import type { GoogleOpeningHoursWire, GooglePlaceWire } from './wire';
import type { GoogleNormalizedValue } from './values';

type LocalDate = { readonly year: number; readonly month: number; readonly day: number };
type LocalPoint = LocalDate & { readonly hour: number; readonly minute: number };
type LocalParts = LocalPoint;
type GoogleOpeningPointWire = NonNullable<
  NonNullable<GoogleOpeningHoursWire['periods']>[number]['open']
>;
type GoogleOpeningPeriodWire = NonNullable<GoogleOpeningHoursWire['periods']>[number];
type PeriodPoints = {
  readonly open: LocalPoint;
  readonly end: LocalPoint | null;
  readonly endTruncated: boolean;
};
type AbsoluteInterval = { readonly start: number; readonly end: number | null };

const DAY_MS = 24 * 60 * 60 * 1_000;
const SAMPLE_STEP_MS = 6 * 60 * 60 * 1_000;
const SAMPLE_RADIUS_MS = 4 * DAY_MS;

export type GoogleOpeningHoursNormalizationOptions = {
  /** Server clock; provider local timestamps are resolved against the returned IANA zone. */
  readonly evaluatedAt: string;
};
export type GoogleOpeningHoursNormalizationInput = GoogleOpeningHoursNormalizationOptions | string;

const unknownValue = <T>(reason: string): GoogleNormalizedValue<T> => ({
  status: 'unknown',
  reason,
});

const errorValue = <T>(
  code: 'SCHEMA_MISMATCH' | 'SOURCE_CONFLICT',
  reason: string,
): GoogleNormalizedValue<T> => ({ status: 'error', code, reason });

const isCalendarDate = (date: LocalDate): boolean => {
  if (!Number.isSafeInteger(date.year) || date.year < 1 || date.year > 9_999) return false;
  if (!Number.isSafeInteger(date.month) || date.month < 1 || date.month > 12) return false;
  if (!Number.isSafeInteger(date.day) || date.day < 1 || date.day > 31) return false;
  const candidate = new Date(0);
  candidate.setUTCFullYear(date.year, date.month - 1, date.day);
  candidate.setUTCHours(0, 0, 0, 0);
  return (
    candidate.getUTCFullYear() === date.year &&
    candidate.getUTCMonth() === date.month - 1 &&
    candidate.getUTCDate() === date.day
  );
};

const localEpoch = (point: LocalPoint): number => {
  const date = new Date(0);
  date.setUTCFullYear(point.year, point.month - 1, point.day);
  date.setUTCHours(point.hour, point.minute, 0, 0);
  return date.getTime();
};

const dateFromWire = (
  point: GoogleOpeningPointWire,
  fallbackDate?: LocalDate,
): LocalPoint | undefined => {
  const date = point.date ?? fallbackDate;
  const hour = point.hour ?? 0;
  const minute = point.minute ?? 0;
  if (date === undefined || !isCalendarDate(date)) {
    return undefined;
  }
  return { year: date.year, month: date.month, day: date.day, hour, minute };
};

const formatterFor = (timeZone: string): Intl.DateTimeFormat | undefined => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return undefined;
  }
};

const partsAt = (formatter: Intl.DateTimeFormat, epochMs: number): LocalParts | undefined => {
  const values = new Map(
    formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]),
  );
  const year = Number(values.get('year'));
  const month = Number(values.get('month'));
  const day = Number(values.get('day'));
  const hour = Number(values.get('hour'));
  const minute = Number(values.get('minute'));
  const parts = { year, month, day, hour, minute };
  return Object.values(parts).every((value) => Number.isSafeInteger(value)) ? parts : undefined;
};

const samePoint = (left: LocalPoint, right: LocalPoint): boolean =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute;

const localDateAt = (formatter: Intl.DateTimeFormat, epochMs: number): LocalDate | undefined => {
  const parts = partsAt(formatter, epochMs);
  return parts === undefined ? undefined : { year: parts.year, month: parts.month, day: parts.day };
};

const collectOffsets = (
  formatter: Intl.DateTimeFormat,
  points: readonly LocalPoint[],
): Set<number> | undefined => {
  if (points.length === 0) return new Set();
  const naiveValues = points.map(localEpoch);
  const first = Math.min(...naiveValues) - SAMPLE_RADIUS_MS;
  const last = Math.max(...naiveValues) + SAMPLE_RADIUS_MS;
  const sampleCount = Math.ceil((last - first) / SAMPLE_STEP_MS) + 1;
  if (!Number.isSafeInteger(sampleCount) || sampleCount > 2_000) return undefined;
  const offsets = new Set<number>();
  for (let sample = first; sample <= last; sample += SAMPLE_STEP_MS) {
    const observed = partsAt(formatter, sample);
    if (observed === undefined) return undefined;
    offsets.add(localEpoch(observed) - sample);
  }
  return offsets;
};

/** Resolves a local wall time only when it maps to exactly one instant in the IANA zone. */
const resolveLocalPoint = (
  point: LocalPoint,
  formatter: Intl.DateTimeFormat,
  offsets: ReadonlySet<number>,
): number | undefined => {
  const naive = localEpoch(point);
  const matches = new Set<number>();
  for (const offset of offsets) {
    const candidate = naive - offset;
    const observed = partsAt(formatter, candidate);
    if (observed !== undefined && samePoint(observed, point)) matches.add(candidate);
  }
  return matches.size === 1 ? [...matches][0] : undefined;
};

const timestamp = (value: string | undefined): number | undefined => {
  if (value === undefined || !v.safeParse(IsoTimestampSchema, value).success) return undefined;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : undefined;
};

/** Google reserves day=0/hour=0/minute=0 with no close for its always-open marker. */
const periodPoints = (
  period: GoogleOpeningPeriodWire,
  fallbackDate: LocalDate | undefined,
): PeriodPoints | undefined => {
  if (period.open === undefined) return undefined;
  const hour = period.open.hour ?? 0;
  const minute = period.open.minute ?? 0;
  const day = period.open.day ?? 0;
  const alwaysOpenPoint = period.open.truncated !== true && day === 0 && hour === 0 && minute === 0;
  const dateFallback =
    period.close === undefined && period.open.date === undefined && alwaysOpenPoint
      ? fallbackDate
      : undefined;
  const open = dateFromWire(period.open, dateFallback);
  if (open === undefined || open.hour !== hour || open.minute !== minute) return undefined;

  if (period.close === undefined) {
    if (!alwaysOpenPoint) return undefined;
    return { open, end: null, endTruncated: false };
  }

  const close = dateFromWire(period.close);
  return close === undefined
    ? undefined
    : { open, end: close, endTruncated: period.close.truncated === true };
};

const periodInterval = (
  period: PeriodPoints,
  formatter: Intl.DateTimeFormat,
  offsets: ReadonlySet<number>,
): AbsoluteInterval | undefined => {
  if (period.endTruncated) return undefined;
  const start = resolveLocalPoint(period.open, formatter, offsets);
  if (start === undefined) return undefined;
  if (period.end === null) return { start, end: null };
  const end = resolveLocalPoint(period.end, formatter, offsets);
  return end === undefined || end <= start ? undefined : { start, end };
};

const weeklyTextFor = (
  current: GoogleOpeningHoursWire | undefined,
  regular: GoogleOpeningHoursWire | undefined,
): string[] => [...(regular?.weekdayDescriptions ?? current?.weekdayDescriptions ?? [])];

const boundaryFor = (
  current: GoogleOpeningHoursWire,
  evaluatedAtMs: number,
): number | null | 'invalid' => {
  const openNow = current.openNow;
  const nextOpen = timestamp(current.nextOpenTime);
  const nextClose = timestamp(current.nextCloseTime);
  if (
    (current.nextOpenTime !== undefined && nextOpen === undefined) ||
    (current.nextCloseTime !== undefined && nextClose === undefined)
  ) {
    return 'invalid';
  }
  if (openNow === undefined) {
    return nextOpen !== undefined || nextClose !== undefined ? 'invalid' : null;
  }
  if (openNow && nextOpen !== undefined) return 'invalid';
  if (!openNow && nextClose !== undefined) return 'invalid';
  const boundary = openNow ? nextClose : nextOpen;
  if (boundary !== undefined && boundary <= evaluatedAtMs) return 'invalid';
  return boundary ?? null;
};

const boundariesMatchIntervals = (
  current: GoogleOpeningHoursWire,
  evaluatedAtMs: number,
  intervals: readonly AbsoluteInterval[],
  nextBoundary: number | null,
): boolean => {
  const active = intervals.filter(
    (interval) =>
      interval.start <= evaluatedAtMs && (interval.end === null || evaluatedAtMs < interval.end),
  );
  if (current.openNow === true) {
    if (active.length === 0) return false;
    const openEnded = active.some((interval) => interval.end === null);
    if (openEnded) return nextBoundary === null;
    const expectedClose = Math.min(
      ...active.map((interval) => interval.end).filter((end): end is number => end !== null),
    );
    return nextBoundary === null || nextBoundary === expectedClose;
  }
  if (current.openNow === false) {
    if (active.length > 0) return false;
    if (nextBoundary === null) return true;
    const futureStarts = intervals
      .map((interval) => interval.start)
      .filter((start) => start > evaluatedAtMs);
    return futureStarts.length > 0 && nextBoundary === Math.min(...futureStarts);
  }
  return true;
};

export const normalizeGoogleOpeningHours = (
  place: GooglePlaceWire,
  input: GoogleOpeningHoursNormalizationInput,
): GoogleNormalizedValue<OpeningHours> => {
  const evaluatedAtText = typeof input === 'string' ? input : input.evaluatedAt;
  const evaluatedAt = timestamp(evaluatedAtText);
  if (evaluatedAt === undefined) {
    return errorValue('SCHEMA_MISMATCH', 'evaluatedAt must be an RFC3339 timestamp');
  }
  const timeZone = place.timeZone?.id;
  if (timeZone === undefined) return unknownValue('Google did not provide an IANA time zone');
  const formatter = formatterFor(timeZone);
  if (formatter === undefined) {
    return errorValue('SCHEMA_MISMATCH', 'Google returned an invalid IANA time zone');
  }
  const current = place.currentOpeningHours;
  if (current === undefined || current.periods === undefined) {
    return unknownValue('dated current opening periods are unavailable');
  }

  const fallbackDate = localDateAt(formatter, evaluatedAt);
  if (fallbackDate === undefined) return unknownValue('provider time zone could not resolve today');
  const periods: PeriodPoints[] = [];
  const points: LocalPoint[] = [];
  for (const period of current.periods) {
    const resolved = periodPoints(period, fallbackDate);
    if (resolved === undefined) {
      return unknownValue('Google opening period is missing a usable local date');
    }
    periods.push(resolved);
    points.push(resolved.open);
    if (resolved.end !== null) points.push(resolved.end);
  }
  const offsets = collectOffsets(formatter, points);
  if (offsets === undefined) {
    return unknownValue('Google opening periods exceed the safely resolvable time window');
  }
  const intervals: AbsoluteInterval[] = [];
  for (const period of periods) {
    const interval = periodInterval(period, formatter, offsets);
    if (interval === undefined) {
      return unknownValue('Google opening period is missing a unique local time');
    }
    intervals.push(interval);
  }
  intervals.sort((left, right) => left.start - right.start);

  const nextBoundary = boundaryFor(current, evaluatedAt);
  if (nextBoundary === 'invalid') {
    return errorValue('SOURCE_CONFLICT', 'openNow and next opening boundary disagree');
  }
  if (!boundariesMatchIntervals(current, evaluatedAt, intervals, nextBoundary)) {
    return errorValue('SOURCE_CONFLICT', 'openNow and current opening periods disagree');
  }
  const weeklyText = weeklyTextFor(current, place.regularOpeningHours);
  const value: OpeningHours = {
    timeZone,
    intervals: intervals.map((interval) => ({
      startAt: new Date(interval.start).toISOString(),
      endAt: interval.end === null ? null : new Date(interval.end).toISOString(),
    })),
    weeklyText,
    evaluatedAt: evaluatedAtText,
    listedOpenAtEvaluation: current.openNow ?? null,
    nextBoundaryAt: nextBoundary === null ? null : new Date(nextBoundary).toISOString(),
    lastOrderAt: null,
    lastOrderRaw: null,
  };
  const parsed = v.safeParse(OpeningHoursSchema, value);
  return parsed.success
    ? { status: 'known', value: parsed.output }
    : errorValue('SCHEMA_MISMATCH', 'normalized opening hours did not satisfy the Core schema');
};
