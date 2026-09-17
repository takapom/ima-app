import { OpeningHoursSchema, type OpeningHours } from '@core/domain/place-values';
import {
  issue,
  parseObservationValue,
  type KnownObservationField,
  type ResolvedObservation,
  type SubmitValidationIssue,
} from '@core/application/submission/submit-cards-evidence';

/** Round elapsed milliseconds down so sub-second input never overstates available stay. */
export const elapsedSecondsFloor = (endMilliseconds: number, startMilliseconds: number): number =>
  Math.floor((endMilliseconds - startMilliseconds) / 1000);

export const openIntervalAt = (
  hours: OpeningHours,
  instant: string,
): OpeningHours['intervals'][number] | undefined => {
  const instantMilliseconds = Date.parse(instant);
  return hours.intervals.find(
    (interval) =>
      Date.parse(interval.startAt) <= instantMilliseconds &&
      (interval.endAt === null || instantMilliseconds < Date.parse(interval.endAt)),
  );
};

export const minimumStayIssue = (
  candidateId: string,
  selectionPath: string,
  observations: Map<KnownObservationField, ResolvedObservation>,
  arrivalAt: string,
  minimumStayMinutes: number,
  deadlineAt?: string,
): SubmitValidationIssue | undefined => {
  const opening = observations.get('opening_hours');
  const hours =
    opening === undefined
      ? undefined
      : parseObservationValue(opening.observation, OpeningHoursSchema);
  if (hours === undefined) {
    return issue(
      'MISSING_EVIDENCE',
      `${selectionPath}.openingHours`,
      'minimum stay requires opening-hours evidence',
      ['opening_hours'],
      candidateId,
    );
  }
  const interval = openIntervalAt(hours, arrivalAt);
  if (interval === undefined) {
    return issue(
      'CONSTRAINT_VIOLATION',
      `${selectionPath}.openingHours`,
      'minimum stay cannot start outside an open arrival interval',
      ['opening_hours'],
      candidateId,
      opening === undefined ? undefined : [opening.observation.observationId],
    );
  }
  const arrivalMilliseconds = Date.parse(arrivalAt);
  const closingMilliseconds =
    interval.endAt === null ? Number.POSITIVE_INFINITY : Date.parse(interval.endAt);
  const deadlineMilliseconds =
    deadlineAt === undefined
      ? closingMilliseconds
      : Math.min(closingMilliseconds, Date.parse(deadlineAt));
  const availableStaySeconds = elapsedSecondsFloor(deadlineMilliseconds, arrivalMilliseconds);
  if (
    availableStaySeconds !== Number.POSITIVE_INFINITY &&
    (!Number.isFinite(availableStaySeconds) || availableStaySeconds < minimumStayMinutes * 60)
  ) {
    return issue(
      'CONSTRAINT_VIOLATION',
      `${selectionPath}.minimumStayMinutes`,
      'opening interval and travel deadline do not leave the required minimum stay',
      ['minimumStayMinutes', 'opening_hours'],
      candidateId,
      opening === undefined ? undefined : [opening.observation.observationId],
    );
  }
  return undefined;
};
