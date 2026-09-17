import * as v from 'valibot';
import {
  JOURNEY_VERIFICATION_MAX_AGE_MS,
  JourneyRecordSchema,
  JourneyServiceDateContextSchema,
  weekdayForCalendarDate,
  type JourneyRecord,
  type JourneyServiceDateContext,
} from '@core/domain/journey';
import { IsoTimestampSchema } from '@core/domain/primitives';
import type { Issue } from '@core/domain/issue';

export type JourneyValidationResult =
  | { readonly status: 'valid'; readonly journey: JourneyRecord }
  | { readonly status: 'invalid'; readonly issues: readonly Issue[] };

export type JourneyDisabledReason = 'missing' | 'stale' | 'not_operating' | 'invalid';

export type JourneyAvailability =
  | {
      readonly status: 'known';
      readonly journey: JourneyRecord;
      readonly walkingVerificationRequired: true;
    }
  | {
      readonly status: 'not_applicable';
      readonly reason: 'same_station';
      readonly walkingVerificationRequired: true;
    }
  | {
      readonly status: 'disabled';
      readonly reason: JourneyDisabledReason;
      readonly issues: readonly Issue[];
      readonly walkingVerificationRequired: true;
    };

const issue = (
  code: Issue['code'],
  path: string,
  message: string,
  missingFields: readonly string[] = [],
): Issue => ({
  code,
  path,
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [...missingFields],
});

const invalid = (...issues: Issue[]): JourneyValidationResult => ({
  status: 'invalid',
  issues,
});

const validationIssue = (input: unknown): Issue =>
  issue(
    'INVALID_EVIDENCE',
    'journey',
    'journey record does not satisfy the Core contract',
    typeof input === 'object' && input !== null ? [] : ['journey'],
  );

const serviceDateContextIssue = (context: JourneyServiceDateContext): Issue | undefined => {
  const expectedWeekday = weekdayForCalendarDate(context.serviceDate);
  return expectedWeekday === context.weekday
    ? undefined
    : issue(
        'MISSING_CONTEXT',
        'journey.weekday',
        'service-date context weekday does not match the calendar date',
        ['weekday'],
      );
};

/** Validates an imported record without deciding which service date will consume it. */
export const validateJourneyRecord = (input: unknown, now: string): JourneyValidationResult => {
  const parsedNow = v.safeParse(IsoTimestampSchema, now);
  if (!parsedNow.success) {
    return invalid(issue('MISSING_CONTEXT', 'journey.now', 'journey validation clock is invalid'));
  }
  const parsed = v.safeParse(JourneyRecordSchema, input);
  if (!parsed.success) return invalid(validationIssue(input));
  if (
    parsed.output.serviceDate < parsed.output.validFrom ||
    parsed.output.serviceDate > parsed.output.validThrough
  ) {
    return invalid(
      issue(
        'INVALID_EVIDENCE',
        'journey.validity',
        'journey service date is outside the imported validity window',
        ['serviceDate', 'validFrom', 'validThrough'],
      ),
    );
  }

  const ageMs = Date.parse(parsedNow.output) - Date.parse(parsed.output.verifiedAt);
  if (ageMs < 0) {
    return invalid(
      issue(
        'INVALID_EVIDENCE',
        'journey.verifiedAt',
        'journey verification time is in the future',
        ['verifiedAt'],
      ),
    );
  }
  if (ageMs >= JOURNEY_VERIFICATION_MAX_AGE_MS) {
    return invalid(
      issue(
        'STALE_EVIDENCE',
        'journey.verifiedAt',
        'journey verification is older than seven days',
        ['verifiedAt'],
      ),
    );
  }
  return { status: 'valid', journey: parsed.output };
};

/** Applies service-date, weekday, holiday, station, and validity-window constraints. */
export const validateJourneyForServiceDate = (
  input: unknown,
  context: JourneyServiceDateContext,
): JourneyValidationResult => {
  const parsedContext = v.safeParse(JourneyServiceDateContextSchema, context);
  if (!parsedContext.success) {
    return invalid(
      issue('MISSING_CONTEXT', 'journey.serviceDate', 'service-date context is invalid'),
    );
  }
  const contextIssue = serviceDateContextIssue(parsedContext.output);
  if (contextIssue !== undefined) return invalid(contextIssue);
  const base = validateJourneyRecord(input, parsedContext.output.now);
  if (base.status === 'invalid') return base;
  const { journey } = base;
  const issues: Issue[] = [];
  if (journey.fromStationRef !== parsedContext.output.fromStationRef) {
    issues.push(
      issue(
        'CONSTRAINT_VIOLATION',
        'journey.fromStationRef',
        'journey origin station does not match the requested station',
        ['fromStationRef'],
      ),
    );
  }
  if (journey.homeStationRef !== parsedContext.output.homeStationRef) {
    issues.push(
      issue(
        'CONSTRAINT_VIOLATION',
        'journey.homeStationRef',
        'journey destination station does not match the requested station',
        ['homeStationRef'],
      ),
    );
  }
  if (journey.serviceDate !== parsedContext.output.serviceDate) {
    issues.push(
      issue(
        'CONSTRAINT_VIOLATION',
        'journey.serviceDate',
        'journey does not apply to the requested service date',
        ['serviceDate'],
      ),
    );
  }
  if (!journey.servicePattern.weekdays.includes(parsedContext.output.weekday)) {
    issues.push(
      issue(
        'CONSTRAINT_VIOLATION',
        'journey.servicePattern.weekdays',
        'journey does not operate on the requested weekday',
        ['weekday'],
      ),
    );
  }
  if (
    (journey.servicePattern.holidayPolicy === 'excluded' && parsedContext.output.isHoliday) ||
    (journey.servicePattern.holidayPolicy === 'only' && !parsedContext.output.isHoliday)
  ) {
    issues.push(
      issue(
        'CONSTRAINT_VIOLATION',
        'journey.servicePattern.holidayPolicy',
        'journey holiday policy does not apply to the requested date',
        ['isHoliday'],
      ),
    );
  }
  if (
    parsedContext.output.serviceDate < journey.validFrom ||
    parsedContext.output.serviceDate > journey.validThrough
  ) {
    issues.push(
      issue('CONSTRAINT_VIOLATION', 'journey.validity', 'journey is outside its valid date range', [
        'validFrom',
        'validThrough',
      ]),
    );
  }
  return issues.length === 0 ? base : invalid(...issues);
};

export const classifyJourneyForServiceDate = (
  input: unknown,
  context: JourneyServiceDateContext,
): JourneyAvailability => {
  const parsedContext = v.safeParse(JourneyServiceDateContextSchema, context);
  if (!parsedContext.success) {
    return {
      status: 'disabled',
      reason: 'invalid',
      issues: [issue('MISSING_CONTEXT', 'journey.serviceDate', 'service-date context is invalid')],
      walkingVerificationRequired: true,
    };
  }
  const normalizedContext = parsedContext.output;
  const contextIssue = serviceDateContextIssue(normalizedContext);
  if (contextIssue !== undefined) {
    return {
      status: 'disabled',
      reason: 'invalid',
      issues: [contextIssue],
      walkingVerificationRequired: true,
    };
  }
  if (normalizedContext.fromStationRef === normalizedContext.homeStationRef) {
    return {
      status: 'not_applicable',
      reason: 'same_station',
      walkingVerificationRequired: true,
    };
  }
  if (input === undefined) {
    return {
      status: 'disabled',
      reason: 'missing',
      issues: [
        issue(
          'MISSING_EVIDENCE',
          'journey',
          'journey record is unavailable for the requested station pair',
          ['journey'],
        ),
      ],
      walkingVerificationRequired: true,
    };
  }
  const validation = validateJourneyForServiceDate(input, normalizedContext);
  if (validation.status === 'valid') {
    return { status: 'known', journey: validation.journey, walkingVerificationRequired: true };
  }
  const reason: JourneyDisabledReason = validation.issues.some(
    (item) => item.code === 'STALE_EVIDENCE',
  )
    ? 'stale'
    : validation.issues.some((item) => item.code === 'CONSTRAINT_VIOLATION')
      ? 'not_operating'
      : 'invalid';
  return {
    status: 'disabled',
    reason,
    issues: validation.issues,
    walkingVerificationRequired: true,
  };
};
