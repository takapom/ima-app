import * as v from 'valibot';
import { JOURNEY_EXIT_BUFFER_SECONDS } from '@worker/domain/travel/journey';
import { LastTrainInfoSchema, type LastTrainInfo } from '@worker/domain/places/place-values';
import { IsoTimestampSchema, SafeIntegerSchema } from '@worker/domain/primitives';
import type { Issue } from '@worker/domain/issue';
import type { Result } from '@worker/domain/result';

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

export type LastTrainRecalculationInput = {
  readonly info: LastTrainInfo;
  readonly arrivalAt: string;
  /** Earliest arrival allowed by the walking observation's evaluatedAt and duration. */
  readonly earliestStoredArrivalAt: string;
  readonly minimumStayMinutes: number;
};

const error = (
  message: string,
  path = 'last_train',
): Extract<Result<LastTrainInfo>, { status: 'error' }> => ({
  status: 'error',
  error: {
    code: 'INVALID_EVIDENCE',
    path,
    retryable: false,
    retryAfterMs: null,
    message,
    missingFields: ['last_train'],
  } satisfies Issue,
});

const elapsedSecondsFloor = (endMilliseconds: number, startMilliseconds: number): number =>
  Math.floor((endMilliseconds - startMilliseconds) / 1000);

/** Recomputes only time-derived LastTrainInfo fields at the submit-time arrival. */
export const recalculateLastTrainAtArrival = (
  input: LastTrainRecalculationInput,
): Result<LastTrainInfo> => {
  const parsedInfo = v.safeParse(LastTrainInfoSchema, input.info);
  const parsedArrival = v.safeParse(IsoTimestampSchema, input.arrivalAt);
  const parsedEarliestStoredArrival = v.safeParse(
    IsoTimestampSchema,
    input.earliestStoredArrivalAt,
  );
  const parsedMinimum = v.safeParse(
    v.pipe(SafeIntegerSchema, v.minValue(1), v.maxValue(180)),
    input.minimumStayMinutes,
  );
  if (
    !parsedInfo.success ||
    !parsedArrival.success ||
    !parsedEarliestStoredArrival.success ||
    !parsedMinimum.success
  ) {
    return error('last-train recalculation input is invalid');
  }

  const info = parsedInfo.output;
  const departureMilliseconds = Date.parse(info.lastDepartureAt);
  const arrivesHomeMilliseconds = Date.parse(info.arrivesHomeAt);
  const storedArrivalMilliseconds = Date.parse(info.arrivePlaceAt);
  const currentArrivalMilliseconds = Date.parse(parsedArrival.output);
  const earliestStoredArrivalMilliseconds = Date.parse(parsedEarliestStoredArrival.output);
  const stationAndBufferSeconds = info.placeToStationSeconds + JOURNEY_EXIT_BUFFER_SECONDS;
  const stationAndBufferMilliseconds = stationAndBufferSeconds * 1000;
  if (
    !Number.isFinite(departureMilliseconds) ||
    !Number.isFinite(arrivesHomeMilliseconds) ||
    !Number.isFinite(storedArrivalMilliseconds) ||
    !Number.isFinite(currentArrivalMilliseconds) ||
    !Number.isFinite(earliestStoredArrivalMilliseconds) ||
    !Number.isSafeInteger(stationAndBufferSeconds) ||
    !Number.isSafeInteger(stationAndBufferMilliseconds)
  ) {
    return error('last-train timestamps are not representable');
  }

  const expectedLeaveByMilliseconds = departureMilliseconds - stationAndBufferMilliseconds;
  if (
    !Number.isSafeInteger(expectedLeaveByMilliseconds) ||
    expectedLeaveByMilliseconds < -MAX_DATE_MILLISECONDS ||
    expectedLeaveByMilliseconds > MAX_DATE_MILLISECONDS
  ) {
    return error('last-train leave-by timestamp is not representable');
  }
  if (Date.parse(info.leaveBy) !== expectedLeaveByMilliseconds) {
    return error('last-train leave-by arithmetic is inconsistent', 'last_train.leaveBy');
  }
  if (arrivesHomeMilliseconds < departureMilliseconds) {
    return error('last-train home arrival precedes the last departure', 'last_train.arrivesHomeAt');
  }
  if (storedArrivalMilliseconds < earliestStoredArrivalMilliseconds) {
    return error(
      'last-train arrival precedes the walking observation timestamp',
      'last_train.arrivePlaceAt',
    );
  }
  if (storedArrivalMilliseconds > expectedLeaveByMilliseconds) {
    return error('last-train arrival is after the leave-by deadline', 'last_train.arrivePlaceAt');
  }

  const storedStaySeconds = elapsedSecondsFloor(
    expectedLeaveByMilliseconds,
    storedArrivalMilliseconds,
  );
  if (!Number.isSafeInteger(storedStaySeconds) || info.availableStaySeconds !== storedStaySeconds) {
    return error(
      'last-train stored stay arithmetic is inconsistent',
      'last_train.availableStaySeconds',
    );
  }
  if (storedArrivalMilliseconds > currentArrivalMilliseconds) {
    return error(
      'last-train evidence is newer than the submit-time arrival',
      'last_train.arrivePlaceAt',
    );
  }

  const availableStaySeconds = elapsedSecondsFloor(
    expectedLeaveByMilliseconds,
    currentArrivalMilliseconds,
  );
  if (!Number.isSafeInteger(availableStaySeconds)) {
    return error('last-train current stay arithmetic is not representable');
  }
  const minimumStayMinutes = parsedMinimum.output;
  const recalculated: LastTrainInfo = {
    ...info,
    arrivePlaceAt: new Date(currentArrivalMilliseconds).toISOString(),
    leaveBy: new Date(expectedLeaveByMilliseconds).toISOString(),
    availableStaySeconds,
    minimumStayMinutes,
    usable: availableStaySeconds >= minimumStayMinutes * 60,
  };
  const parsed = v.safeParse(LastTrainInfoSchema, recalculated);
  return parsed.success
    ? { status: 'ok', data: parsed.output, warnings: [] }
    : error('last-train recalculation output is invalid');
};
