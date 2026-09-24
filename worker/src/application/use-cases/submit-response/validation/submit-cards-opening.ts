import { OpeningHoursSchema, type OpeningHours } from '@worker/domain/places/place-values';
import {
  issue,
  parseObservationValue,
  type KnownObservationField,
  type ResolvedObservation,
  type SubmitValidationContext,
  type SubmitValidationIssue,
} from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';

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

/**
 * Checks the listed opening hours at the server's current time. A listing that does not state
 * whether the shop is open is accepted only when the Harness explicitly allows unknown opening.
 */
export const validateOpening = (
  candidateId: string,
  selectionPath: string,
  context: SubmitValidationContext,
  observations: Map<KnownObservationField, ResolvedObservation>,
): SubmitValidationIssue[] => {
  const opening = observations.get('opening_hours');
  // A missing observation is reported by the card's required-field check.
  if (opening === undefined) return [];
  const observationId = opening.observation.observationId;
  const hours = parseObservationValue(opening.observation, OpeningHoursSchema);
  if (hours === undefined) {
    return [
      issue(
        'CONSTRAINT_VIOLATION',
        `${selectionPath}.openingHours`,
        'opening status is not confirmed by the observation',
        ['opening_hours'],
        candidateId,
        [observationId],
      ),
    ];
  }
  const issues: SubmitValidationIssue[] = [];
  const checkOpening = hours.listedOpenAtEvaluation !== null || !context.allowUnknownOpening;
  if (checkOpening && hours.listedOpenAtEvaluation !== true) {
    issues.push(
      issue(
        'CONSTRAINT_VIOLATION',
        `${selectionPath}.openingHours`,
        'opening observation was not listed as open at evaluation',
        ['listedOpenAtEvaluation'],
        candidateId,
        [observationId],
      ),
    );
  }
  if (checkOpening && openIntervalAt(hours, context.serverNow) === undefined) {
    issues.push(
      issue(
        'CONSTRAINT_VIOLATION',
        `${selectionPath}.openingHours`,
        'candidate is not open at the current server time',
        ['opening_hours'],
        candidateId,
        [observationId],
      ),
    );
  }
  if (context.requireLastOrderAtArrival) {
    if (hours.lastOrderAt === null) {
      issues.push(
        issue(
          'MISSING_EVIDENCE',
          `${selectionPath}.lastOrder`,
          'last-order time is required but unavailable',
          ['lastOrderAt'],
          candidateId,
          [observationId],
        ),
      );
    } else if (Date.parse(context.serverNow) > Date.parse(hours.lastOrderAt)) {
      issues.push(
        issue(
          'CONSTRAINT_VIOLATION',
          `${selectionPath}.lastOrder`,
          'current time is after last order',
          ['lastOrderAt'],
          candidateId,
          [observationId],
        ),
      );
    }
  }
  return issues;
};
