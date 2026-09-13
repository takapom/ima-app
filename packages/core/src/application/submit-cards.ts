import * as v from 'valibot';
import { EvidenceTextSchema } from '../domain/evidence';
import {
  OpeningHoursSchema,
  PlaceIdentitySchema,
  PhotoInfoSchema,
  PriceInfoSchema,
  WalkingRouteSchema,
} from '../domain/place-values';
import { SubmitCardsInputSchema, type CardSelection, type SubmitCardsInput } from '../ports/model';
import type { CandidateObservationRegistryPort } from '../ports/registry';
import {
  SubmitValidationContextSchema,
  invalid,
  issue,
  parseObservationValue,
  resolveEvidenceText,
  resolveObservation,
  type ResolvedObservation,
  type KnownObservationField,
  type SubmitValidationContext,
  type SubmitValidationIssue,
  type SubmitValidationResult,
  type ValidatedCard,
  type ValidatedCardsResponse,
  type ValidatedEvidenceText,
  type ValidatedMessageResponse,
} from './submission/submit-cards-evidence';
import { validateArrivalAndOpening, validateLastTrain } from './submit-cards-travel';

export type { SubmitValidationContext } from './submission/submit-cards-evidence';

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
  const byId = new Map<string, ResolvedObservation>();
  const byField = new Map<KnownObservationField, ResolvedObservation>();
  const issues: SubmitValidationIssue[] = [];
  for (const [evidenceIndex, id] of selection.evidenceIds.entries()) {
    const resolved = resolveObservation(
      id,
      selection.candidateId,
      `${path}.evidenceIds[${evidenceIndex}]`,
      context,
      registry,
    );
    if (resolved.issue !== undefined) {
      issues.push(resolved.issue);
    } else if (resolved.resolved !== undefined) {
      byId.set(id, resolved.resolved);
      if (!byField.has(resolved.resolved.evidence.field)) {
        byField.set(resolved.resolved.evidence.field, resolved.resolved);
      }
    }
  }
  const identityObservation = byField.get('identity');
  const openingObservation = byField.get('opening_hours');
  if (identityObservation === undefined)
    issues.push(
      issue(
        'MISSING_EVIDENCE',
        `${path}.evidenceIds`,
        'identity evidence is required',
        ['identity'],
        selection.candidateId,
      ),
    );
  if (openingObservation === undefined)
    issues.push(
      issue(
        'MISSING_EVIDENCE',
        `${path}.evidenceIds`,
        'opening-hours evidence is required',
        ['opening_hours'],
        selection.candidateId,
      ),
    );
  const identity =
    identityObservation === undefined
      ? undefined
      : parseObservationValue(identityObservation.observation, PlaceIdentitySchema);
  if (identity === undefined && identityObservation !== undefined)
    issues.push(
      issue(
        'INVALID_EVIDENCE',
        `${path}.evidenceIds`,
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
        `${path}.evidenceIds`,
        'opening-hours observation value is invalid',
        ['opening_hours'],
        selection.candidateId,
      ),
    );
  issues.push(...validateArrivalAndOpening(selection.candidateId, path, context, byField));
  const walkingObservation = byField.get('walking_route');
  const walkingRoute =
    walkingObservation === undefined
      ? undefined
      : parseObservationValue(walkingObservation.observation, WalkingRouteSchema);
  if (walkingRoute === undefined && walkingObservation !== undefined)
    issues.push(
      issue(
        'INVALID_EVIDENCE',
        `${path}.evidenceIds`,
        'walking observation value is invalid',
        ['walking_route'],
        selection.candidateId,
      ),
    );
  const lastTrain = validateLastTrain(selection.candidateId, path, context, byField);
  issues.push(...lastTrain.issues);
  const why = resolveEvidenceText(
    selection.why,
    selection.candidateId,
    `${path}.why`,
    context,
    registry,
    byId,
  );
  if (why.status === 'invalid') issues.push(...why.issues);
  const diff =
    selection.diff === undefined
      ? null
      : resolveEvidenceText(
          selection.diff,
          selection.candidateId,
          `${path}.diff`,
          context,
          registry,
          byId,
        );
  if (diff?.status === 'invalid') issues.push(...diff.issues);
  if (
    issues.length > 0 ||
    identity === undefined ||
    opening === undefined ||
    why.status === 'invalid' ||
    (diff !== null && diff.status === 'invalid')
  )
    return invalid(...issues);
  if (why.status !== 'valid')
    return invalid(
      issue(
        'INVALID_EVIDENCE',
        `${path}.why`,
        'why evidence could not be resolved',
        [],
        selection.candidateId,
      ),
    );
  const priceObservation = byField.get('price');
  const photosObservation = byField.get('photos');
  const price =
    priceObservation === undefined
      ? null
      : (parseObservationValue(priceObservation.observation, PriceInfoSchema) ?? null);
  const photos =
    photosObservation === undefined
      ? null
      : (parseObservationValue(photosObservation.observation, PhotoInfoSchema) ?? null);
  return {
    status: 'valid',
    response: {
      candidateId: selection.candidateId,
      identity,
      openingHours: opening,
      price,
      photos,
      walkingRoute: walkingRoute ?? null,
      lastTrain: lastTrain.info,
      evidenceIds: selection.evidenceIds,
      why: why.response,
      diff: diff === null ? null : diff.status === 'valid' ? diff.response : null,
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
    return invalid(issue('INVALID_ARGUMENT', null, 'submit_cards input is invalid'));
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
  const cache = new Map<string, ResolvedObservation>();
  const messages: ValidatedEvidenceText[] = [];
  for (const [index, message] of inputValue.message.entries()) {
    const result = resolveEvidenceText(
      message,
      null,
      `message[${index}]`,
      parsedContext.response,
      registry,
      cache,
    );
    if (result.status === 'invalid') issues.push(...result.issues);
    else messages.push(result.response);
  }
  if (issues.length > 0 || cards.length !== selections.length) return invalid(...issues);
  const [hero, ...alts] = cards;
  if (hero === undefined)
    return invalid(issue('INVALID_ARGUMENT', 'hero', 'hero card is required'));
  return {
    status: 'valid',
    response: {
      presentation: 'replace',
      message: messages,
      hero,
      alts,
    },
  };
}

export function validateMessage(
  input: unknown,
  context: unknown,
  registry: CandidateObservationRegistryPort,
): SubmitValidationResult<ValidatedMessageResponse> {
  const parsedContext = parseContext(context);
  if (parsedContext.status === 'invalid') return parsedContext;
  const parsedMessage = v.safeParse(EvidenceTextSchema(300), input);
  if (!parsedMessage.success)
    return invalid(issue('INVALID_ARGUMENT', 'message', 'message is invalid'));
  const result = resolveEvidenceText(
    parsedMessage.output,
    null,
    'message',
    parsedContext.response,
    registry,
    new Map(),
  );
  if (result.status === 'invalid') return result;
  return {
    status: 'valid',
    response: {
      presentation: 'keep',
      message: result.response,
    },
  };
}
