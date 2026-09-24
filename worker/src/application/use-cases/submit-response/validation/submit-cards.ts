import * as v from 'valibot';
import { Text } from '@worker/domain/primitives';
import {
  FacilitiesInfoSchema,
  OpeningHoursSchema,
  PlaceIdentitySchema,
  PhotoInfoSchema,
  PriceInfoSchema,
} from '@worker/domain/places/place-values';
import {
  SubmitCardsInputSchema,
  type CardSelection,
  type SubmitCardsInput,
} from '@worker/application/ports/model';
import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import {
  SubmitValidationContextSchema,
  invalid,
  issue,
  parseObservationValue,
  resolveObservation,
  type ResolvedObservation,
  type KnownObservationField,
  type SubmitValidationContext,
  type SubmitValidationIssue,
  type SubmitValidationResult,
  type ValidatedCard,
  type ValidatedCardsResponse,
  type ValidatedMessageResponse,
} from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';
import { validateOpening } from '@worker/application/use-cases/submit-response/validation/submit-cards-opening';

export type { SubmitValidationContext } from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';

/**
 * Fields a card renders. The Core selects their observations from the registry instead of the
 * model copying observation IDs: each candidate passes the same `resolveObservation` checks
 * (scope, candidate, context, freshness, retention, reuse) and the newest valid one wins.
 */
const CARD_FIELDS = ['identity', 'opening_hours', 'price', 'photos', 'facilities'] as const;
type CardField = (typeof CARD_FIELDS)[number];

/** A card cannot be committed without these; the other fields are simply left off the card. */
const REQUIRED_CARD_FIELDS: readonly CardField[] = ['identity', 'opening_hours'];

type AttachedCardObservations = {
  readonly byField: Map<KnownObservationField, ResolvedObservation>;
  readonly evidenceIds: readonly string[];
  /** The newest rejected observation per field, reported when a required field has none. */
  readonly rejected: ReadonlyMap<CardField, SubmitValidationIssue>;
};

const attachCardObservations = (
  candidateId: string,
  path: string,
  context: SubmitValidationContext,
  registry: CandidateObservationRegistryPort,
): AttachedCardObservations => {
  const byField = new Map<KnownObservationField, ResolvedObservation>();
  const evidenceIds: string[] = [];
  const rejected = new Map<CardField, SubmitValidationIssue>();
  const stored = registry.listObservations(context.scope, candidateId);
  for (const field of CARD_FIELDS) {
    const newestFirst = stored
      .filter((observation) => observation.field === field)
      .sort((left, right) => Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt));
    for (const observation of newestFirst) {
      const resolved = resolveObservation(
        observation.observationId,
        candidateId,
        `${path}.${field}`,
        context,
        registry,
      );
      if (resolved.issue !== undefined) {
        if (!rejected.has(field)) rejected.set(field, resolved.issue);
        continue;
      }
      if (resolved.resolved === undefined) continue;
      byField.set(field, resolved.resolved);
      evidenceIds.push(observation.observationId);
      break;
    }
  }
  return { byField, evidenceIds, rejected };
};

const validateCandidate = (
  selection: CardSelection,
  index: number,
  context: SubmitValidationContext,
  registry: CandidateObservationRegistryPort,
): SubmitValidationResult<ValidatedCard> => {
  const path = index === 0 ? 'hero' : `alts[${index - 1}]`;
  const record = registry.readCandidate(context.scope, selection.candidateId);
  if (record === undefined) {
    return invalid(
      issue(
        'UNKNOWN_CANDIDATE',
        `${path}.candidateId`,
        'candidate is not registered in this scope',
        [],
        selection.candidateId,
      ),
    );
  }
  if (record.excluded) {
    return invalid(
      issue(
        'CONSTRAINT_VIOLATION',
        `${path}.candidateId`,
        'candidate is explicitly excluded',
        [],
        selection.candidateId,
      ),
    );
  }
  const attached = attachCardObservations(selection.candidateId, path, context, registry);
  const byField = attached.byField;
  const issues: SubmitValidationIssue[] = [];
  for (const field of REQUIRED_CARD_FIELDS) {
    if (byField.has(field)) continue;
    issues.push(
      attached.rejected.get(field) ??
        issue(
          'MISSING_EVIDENCE',
          `${path}.${field}`,
          `no usable ${field} observation is registered for this candidate`,
          [field],
          selection.candidateId,
        ),
    );
  }
  const identityObservation = byField.get('identity');
  const openingObservation = byField.get('opening_hours');
  const identity =
    identityObservation === undefined
      ? undefined
      : parseObservationValue(identityObservation.observation, PlaceIdentitySchema);
  if (identity === undefined && identityObservation !== undefined)
    issues.push(
      issue(
        'INVALID_EVIDENCE',
        `${path}.identity`,
        'identity observation value is invalid',
        ['identity'],
        selection.candidateId,
      ),
    );
  if (
    identity !== undefined &&
    identityObservation !== undefined &&
    (identity.businessStatus === 'temporarily_closed' ||
      identity.businessStatus === 'permanently_closed')
  ) {
    issues.push(
      issue(
        'CONSTRAINT_VIOLATION',
        `${path}.identity`,
        'closed candidate cannot be committed',
        ['businessStatus'],
        selection.candidateId,
        [identityObservation.observation.observationId],
      ),
    );
  }
  const opening =
    openingObservation === undefined
      ? undefined
      : parseObservationValue(openingObservation.observation, OpeningHoursSchema);
  if (opening === undefined && openingObservation !== undefined)
    issues.push(
      issue(
        'INVALID_EVIDENCE',
        `${path}.openingHours`,
        'opening-hours observation value is invalid',
        ['opening_hours'],
        selection.candidateId,
      ),
    );
  issues.push(...validateOpening(selection.candidateId, path, context, byField));
  if (issues.length > 0 || identity === undefined || opening === undefined)
    return invalid(...issues);
  const priceObservation = byField.get('price');
  const photosObservation = byField.get('photos');
  const facilitiesObservation = byField.get('facilities');
  const price =
    priceObservation === undefined
      ? null
      : (parseObservationValue(priceObservation.observation, PriceInfoSchema) ?? null);
  const photos =
    photosObservation === undefined
      ? null
      : (parseObservationValue(photosObservation.observation, PhotoInfoSchema) ?? null);
  const facilities =
    facilitiesObservation === undefined
      ? null
      : (parseObservationValue(facilitiesObservation.observation, FacilitiesInfoSchema) ?? null);
  return {
    status: 'valid',
    response: {
      candidateId: selection.candidateId,
      identity,
      openingHours: opening,
      price,
      photos,
      facilities,
      evidenceIds: attached.evidenceIds,
      why: selection.why,
      diff: selection.diff ?? null,
    },
  };
};

const parseContext = (context: unknown): SubmitValidationResult<SubmitValidationContext> => {
  const parsed = v.safeParse(SubmitValidationContextSchema, context);
  return parsed.success
    ? { status: 'valid', response: parsed.output }
    : invalid(issue('INVALID_ARGUMENT', 'context', 'submit validation context is invalid'));
};

export function validateSubmitCards(
  input: unknown,
  context: unknown,
  registry: CandidateObservationRegistryPort,
): SubmitValidationResult<ValidatedCardsResponse> {
  const parsedContext = parseContext(context);
  if (parsedContext.status === 'invalid') return parsedContext;
  const parsedInput = v.safeParse(SubmitCardsInputSchema, input);
  if (!parsedInput.success)
    return invalid(issue('INVALID_ARGUMENT', null, 'proposal input is invalid'));
  const inputValue: SubmitCardsInput = parsedInput.output;
  const selections = [inputValue.hero, ...inputValue.alts];
  const cards: ValidatedCard[] = [];
  const issues: SubmitValidationIssue[] = [];
  const candidateIds = new Set<string>();
  for (const [index, selection] of selections.entries()) {
    if (candidateIds.has(selection.candidateId)) {
      issues.push(
        issue(
          'INVALID_ARGUMENT',
          index === 0 ? 'hero.candidateId' : `alts[${index - 1}].candidateId`,
          'candidate is selected more than once',
          [],
          selection.candidateId,
        ),
      );
      continue;
    }
    candidateIds.add(selection.candidateId);
    const result = validateCandidate(selection, index, parsedContext.response, registry);
    if (result.status === 'invalid') issues.push(...result.issues);
    else cards.push(result.response);
  }
  if (issues.length > 0 || cards.length !== selections.length) return invalid(...issues);
  const [hero, ...alts] = cards;
  if (hero === undefined)
    return invalid(issue('INVALID_ARGUMENT', 'hero', 'hero card is required'));
  return {
    status: 'valid',
    response: {
      presentation: 'replace',
      message: inputValue.message,
      hero,
      alts,
    },
  };
}

const MessageInputSchema = v.strictObject({
  kind: v.picklist(['ask', 'answer']),
  message: Text(300),
});

export function validateMessage(
  input: unknown,
  context: unknown,
): SubmitValidationResult<ValidatedMessageResponse> {
  const parsedContext = parseContext(context);
  if (parsedContext.status === 'invalid') return parsedContext;
  const parsed = v.safeParse(MessageInputSchema, input);
  if (!parsed.success) return invalid(issue('INVALID_ARGUMENT', 'message', 'message is invalid'));
  return {
    status: 'valid',
    response: { presentation: 'keep', kind: parsed.output.kind, message: parsed.output.message },
  };
}
