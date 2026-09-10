import * as v from 'valibot';
import {
  JOURNEY_EXIT_BUFFER_SECONDS,
  JourneyRecordSchema,
  type JourneyRecord,
} from '../domain/journey';
import {
  IsoTimestampSchema,
  NonNegativeSafeIntegerSchema,
  SafeIntegerSchema,
} from '../domain/primitives';
import type { Issue } from '../domain/issue';
import type { Result } from '../domain/result';

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

export const JourneyTimingInputSchema = v.strictObject({
  journey: JourneyRecordSchema,
  evaluatedAt: IsoTimestampSchema,
  userToPlaceSeconds: NonNegativeSafeIntegerSchema,
  placeToStationSeconds: NonNegativeSafeIntegerSchema,
  minimumStayMinutes: v.pipe(SafeIntegerSchema, v.minValue(1), v.maxValue(180)),
  closedAt: v.nullable(IsoTimestampSchema),
  lastOrderAt: v.nullable(IsoTimestampSchema),
});
export type JourneyTimingInput = v.InferOutput<typeof JourneyTimingInputSchema>;

export type JourneyTiming = {
  readonly journeyRef: JourneyRecord['journeyRef'];
  readonly serviceDate: JourneyRecord['serviceDate'];
  readonly lastDepartureAt: JourneyRecord['lastDepartureAt'];
  readonly closedAt: JourneyTimingInput['closedAt'];
  readonly lastOrderAt: JourneyTimingInput['lastOrderAt'];
  readonly arrivePlaceAt: string;
  readonly leaveBy: string;
  /** The public LastTrainInfo meaning: leaveBy minus arrival, floored in seconds. */
  readonly availableStaySeconds: number;
  /** A separate closing-hours value; `null` means no finite closing boundary was supplied. */
  readonly availableStayUntilClosingSeconds: number | null;
  /** The earlier of the closing and last-train boundaries, for a caller that combines them. */
  readonly stayDeadlineAt: string;
  /** `null` means the provider did not supply a last-order time. */
  readonly orderableAtArrival: boolean | null;
  readonly usable: boolean;
};

const issue = (path: string, message: string, missingFields: readonly string[] = []): Issue => ({
  code: 'INVALID_EVIDENCE',
  path,
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [...missingFields],
});

const timestampAt = (
  base: string,
  deltaSeconds: number,
  path: string,
): { readonly milliseconds: number; readonly timestamp: string } | { readonly error: Issue } => {
  const baseMilliseconds = Date.parse(base);
  const deltaMilliseconds = deltaSeconds * 1000;
  const milliseconds = baseMilliseconds + deltaMilliseconds;
  if (
    !Number.isSafeInteger(deltaMilliseconds) ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < -MAX_DATE_MILLISECONDS ||
    milliseconds > MAX_DATE_MILLISECONDS
  ) {
    return {
      error: issue(path, 'journey timing cannot produce a representable timestamp', [
        'durationSeconds',
      ]),
    };
  }
  return { milliseconds, timestamp: new Date(milliseconds).toISOString() };
};

const staySeconds = (
  deadlineMilliseconds: number,
  arrivalMilliseconds: number,
): number | undefined => {
  const value = Math.floor((deadlineMilliseconds - arrivalMilliseconds) / 1000);
  return Number.isSafeInteger(value) ? value : undefined;
};

/** Computes the independent arrival, closing, last-order, and last-train deadlines. */
export const calculateJourneyTiming = (input: JourneyTimingInput): Result<JourneyTiming> => {
  const parsed = v.safeParse(JourneyTimingInputSchema, input);
  if (!parsed.success)
    return { status: 'error', error: issue('journey', 'journey timing input is invalid') };

  const value = parsed.output;
  const arrivePlace = timestampAt(
    value.evaluatedAt,
    value.userToPlaceSeconds,
    'journey.arrivePlaceAt',
  );
  if ('error' in arrivePlace) return { status: 'error', error: arrivePlace.error };
  const stationAndBuffer = value.placeToStationSeconds + JOURNEY_EXIT_BUFFER_SECONDS;
  if (!Number.isSafeInteger(stationAndBuffer)) {
    return {
      status: 'error',
      error: issue('journey.leaveBy', 'walking duration and exit buffer are too large'),
    };
  }
  const leaveBy = timestampAt(value.journey.lastDepartureAt, -stationAndBuffer, 'journey.leaveBy');
  if ('error' in leaveBy) return { status: 'error', error: leaveBy.error };

  const closingMilliseconds =
    value.closedAt === null ? leaveBy.milliseconds : Date.parse(value.closedAt);
  const deadlineMilliseconds = Math.min(leaveBy.milliseconds, closingMilliseconds);
  const availableStaySeconds = staySeconds(leaveBy.milliseconds, arrivePlace.milliseconds);
  if (availableStaySeconds === undefined) {
    return {
      status: 'error',
      error: issue('journey.availableStaySeconds', 'available stay is not a safe integer'),
    };
  }
  let availableStayUntilClosingSeconds: number | null = null;
  if (value.closedAt !== null) {
    const closingStay = staySeconds(closingMilliseconds, arrivePlace.milliseconds);
    if (closingStay === undefined) {
      return {
        status: 'error',
        error: issue(
          'journey.availableStayUntilClosingSeconds',
          'closing-limited stay is not a safe integer',
        ),
      };
    }
    availableStayUntilClosingSeconds = closingStay;
  }
  const stayDeadlineAt = new Date(deadlineMilliseconds).toISOString();
  const orderableAtArrival =
    value.lastOrderAt === null ? null : arrivePlace.milliseconds < Date.parse(value.lastOrderAt);
  return {
    status: 'ok',
    data: {
      journeyRef: value.journey.journeyRef,
      serviceDate: value.journey.serviceDate,
      lastDepartureAt: value.journey.lastDepartureAt,
      closedAt: value.closedAt,
      lastOrderAt: value.lastOrderAt,
      arrivePlaceAt: arrivePlace.timestamp,
      leaveBy: leaveBy.timestamp,
      stayDeadlineAt,
      availableStaySeconds,
      availableStayUntilClosingSeconds,
      orderableAtArrival,
      usable: availableStaySeconds >= value.minimumStayMinutes * 60,
    },
    warnings: [],
  };
};
