import { OpeningHoursSchema, type OpeningHours } from '@worker/core/domain/places/place-values';
import {
  issue,
  parseObservationValue,
  type KnownObservationField,
  type ResolvedObservation,
  type SubmitValidationContext,
  type SubmitValidationIssue,
} from '@worker/core/application/use-cases/submit-response/validation/submit-cards-evidence';

/**
 * 掲載された営業区間のうち、指定時刻を含むものを返す。
 * endAt が null の区間は、終端を置かなかった区間として開始以降を含む。
 */
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
 * サーバの現在時刻で、掲載された営業を確認する。
 * 営業していると掲載されていない店は、Harness が不明な営業を明示的に許したときだけ通す。掲載文から営業中を補わない。
 */
export const validateOpening = (
  candidateId: string,
  selectionPath: string,
  context: SubmitValidationContext,
  observations: Map<KnownObservationField, ResolvedObservation>,
): SubmitValidationIssue[] => {
  const opening = observations.get('opening_hours');
  /** 観測欠落はカード必須フィールド検証側が報告する。 */
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
  if (context.requireLastOrder) {
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
