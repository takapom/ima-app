import * as v from 'valibot';
import { type EvidenceBasis, type SourceRef } from '../domain/evidence';
import {
  contextKeyForObservation,
  matchesObservationContext,
  observationFreshness,
  ObservationContextSchema,
  RegistryScopeSchema,
} from '../domain/freshness';
import {
  ContactInfoSchema,
  FacilitiesInfoSchema,
  LastTrainInfoSchema,
  OpeningHoursSchema,
  PlaceIdentitySchema,
  PriceInfoSchema,
  PhotoInfoSchema,
  WalkingRouteSchema,
  type LastTrainInfo,
  type OpeningHours,
  type PlaceIdentity,
  type PriceInfo,
  type WalkingRoute,
} from '../domain/place-values';
import {
  CalendarDateSchema,
  CandidateIdSchema,
  IsoTimestampSchema,
  OpaqueIdSchema,
  SafeIntegerSchema,
} from '../domain/primitives';
import type { RetentionMetadata } from '../domain/retention';
import type { CandidateObservationRegistryPort } from '../ports/registry';
import type { SubmitIssue } from '../ports/submission';
import type { ReadonlyStoredObservation } from '../domain/registry';

const PositiveMinutesSchema = v.pipe(SafeIntegerSchema, v.minValue(1), v.maxValue(180));
type PhotoInfo = v.InferOutput<typeof PhotoInfoSchema>;

/**
 * Conditions supplied by the Harness/Application. They are deliberately separate from model
 * input so the model cannot disable the current-arrival opening check or widen a hard limit.
 */
export const SubmitValidationContextSchema = v.pipe(
  v.strictObject({
    scope: RegistryScopeSchema,
    serverNow: IsoTimestampSchema,
    departureAt: IsoTimestampSchema,
    expectedObservationContext: ObservationContextSchema,
    preferences: v.strictObject({
      maxWalkMinutes: v.nullable(PositiveMinutesSchema),
      homeStationRef: v.nullable(OpaqueIdSchema),
      minimumStayMinutes: v.nullable(PositiveMinutesSchema),
    }),
    travel: v.pipe(
      v.array(
        v.strictObject({
          candidateId: CandidateIdSchema,
          serviceDate: CalendarDateSchema,
          fromStationRef: OpaqueIdSchema,
        }),
      ),
      v.maxLength(3),
      v.check(
        (items) => new Set(items.map((item) => item.candidateId)).size === items.length,
        'travel context candidate IDs must be unique',
      ),
    ),
    requireLastOrderAtArrival: v.boolean(),
  }),
  v.check((context) => {
    const expected = context.expectedObservationContext;
    const sameInstant = Date.parse(context.serverNow) === Date.parse(context.departureAt);
    const scopeMatches =
      expected.ownerScopeRef === context.scope.ownerScopeRef &&
      expected.threadId === context.scope.threadId;
    const preferencesMatch =
      expected.homeStationRef === context.preferences.homeStationRef &&
      expected.minimumStayMinutes === context.preferences.minimumStayMinutes;
    return sameInstant && scopeMatches && preferencesMatch;
  }, 'submit validation context is inconsistent'),
);
export type SubmitValidationContext = v.InferOutput<typeof SubmitValidationContextSchema>;

const KnownObservationFieldSchema = v.picklist([
  'identity',
  'opening_hours',
  'price',
  'photos',
  'contact',
  'facilities',
  'walking_route',
  'last_train',
]);
export type KnownObservationField = v.InferOutput<typeof KnownObservationFieldSchema>;

const knownObservationField = (field: string): field is KnownObservationField =>
  v.safeParse(KnownObservationFieldSchema, field).success;

export type SubmitValidationIssue = {
  code: SubmitIssue['code'];
  path: string | null;
  candidateId?: string;
  evidenceIds?: string[];
  message: string;
  missingFields: string[];
};

export type EvidenceLink = {
  observationId: string;
  candidateId: string;
  field: KnownObservationField;
  sources: readonly SourceRef[];
  retention: RetentionMetadata;
};

export type ValidatedEvidenceText = {
  text: string;
  evidenceIds: readonly string[];
  basis: EvidenceBasis;
  evidence: readonly EvidenceLink[];
};

export type ValidatedCard = {
  candidateId: string;
  identity: PlaceIdentity;
  openingHours: OpeningHours;
  price: PriceInfo | null;
  photos: PhotoInfo | null;
  walkingRoute: WalkingRoute | null;
  lastTrain: LastTrainInfo | null;
  evidenceIds: readonly string[];
  why: ValidatedEvidenceText;
  diff: ValidatedEvidenceText | null;
};

export type ValidatedCardsResponse = {
  presentation: 'replace';
  message: readonly ValidatedEvidenceText[];
  hero: ValidatedCard;
  alts: readonly ValidatedCard[];
};

export type ValidatedMessageResponse = {
  presentation: 'keep';
  message: ValidatedEvidenceText;
};

export type SubmitValidationResult<T> =
  | { status: 'valid'; response: T }
  | { status: 'invalid'; issues: readonly SubmitValidationIssue[] };

export type ResolvedObservation = {
  observation: ReadonlyStoredObservation;
  evidence: EvidenceLink;
};

export const invalid = (...issues: SubmitValidationIssue[]): SubmitValidationResult<never> => ({
  status: 'invalid',
  issues: issues.slice(0, 8),
});

export const issue = (
  code: SubmitIssue['code'],
  path: string | null,
  message: string,
  missingFields: string[] = [],
  candidateId?: string,
  evidenceIds?: string[],
): SubmitValidationIssue => ({
  code,
  path,
  message,
  missingFields,
  ...(candidateId === undefined ? {} : { candidateId }),
  ...(evidenceIds === undefined ? {} : { evidenceIds }),
});

const observationSchema = (field: KnownObservationField): v.GenericSchema => {
  switch (field) {
    case 'identity':
      return PlaceIdentitySchema;
    case 'opening_hours':
      return OpeningHoursSchema;
    case 'price':
      return PriceInfoSchema;
    case 'photos':
      return PhotoInfoSchema;
    case 'contact':
      return ContactInfoSchema;
    case 'facilities':
      return FacilitiesInfoSchema;
    case 'walking_route':
      return WalkingRouteSchema;
    case 'last_train':
      return LastTrainInfoSchema;
  }
};

export const parseObservationValue = <TSchema extends v.GenericSchema>(
  observation: ReadonlyStoredObservation,
  schema: TSchema,
): v.InferOutput<TSchema> | undefined => {
  const parsed = v.safeParse(schema, observation.value);
  return parsed.success ? parsed.output : undefined;
};

const isRetentionUsable = (observation: ReadonlyStoredObservation, now: string): boolean => {
  const retention = observation.retention;
  const boundaries = [retention.sessionExpiresAt, retention.freshUntil, retention.displayUntil];
  return boundaries.every(
    (boundary) => boundary === null || Date.parse(now) < Date.parse(boundary),
  );
};

export const resolveObservation = (
  id: string,
  candidateId: string | null,
  path: string,
  context: SubmitValidationContext,
  registry: CandidateObservationRegistryPort,
): { resolved?: ResolvedObservation; issue?: SubmitValidationIssue } => {
  const observationId = id;
  const observation = registry.readObservation(context.scope, observationId);
  if (observation === undefined) {
    return {
      issue: issue(
        'INVALID_EVIDENCE',
        path,
        'observation is not registered in this scope',
        ['evidenceIds'],
        candidateId ?? undefined,
        [observationId],
      ),
    };
  }
  if (candidateId !== null && observation.candidateId !== candidateId) {
    return {
      issue: issue(
        'INVALID_EVIDENCE',
        path,
        'observation belongs to another candidate',
        [],
        candidateId ?? undefined,
        [observationId],
      ),
    };
  }
  if (!knownObservationField(observation.field)) {
    return {
      issue: issue(
        'INVALID_EVIDENCE',
        path,
        'observation field is unsupported',
        [observation.field],
        candidateId ?? undefined,
        [observationId],
      ),
    };
  }
  if (observation.contextKey !== contextKeyForObservation(observation.context, observation.field)) {
    return {
      issue: issue(
        'INVALID_EVIDENCE',
        path,
        'observation context key is inconsistent',
        ['contextKey'],
        candidateId ?? undefined,
        [observationId],
      ),
    };
  }
  if (!matchesObservationContext(observation.context, context.expectedObservationContext)) {
    return {
      issue: issue(
        'STALE_EVIDENCE',
        path,
        'observation context no longer matches the turn',
        ['context'],
        candidateId ?? undefined,
        [observationId],
      ),
    };
  }
  if (
    observationFreshness(observation, context.serverNow) === 'expired' ||
    !isRetentionUsable(observation, context.serverNow)
  ) {
    return {
      issue: issue(
        'STALE_EVIDENCE',
        path,
        'observation is expired for this turn',
        ['freshUntil'],
        candidateId ?? undefined,
        [observationId],
      ),
    };
  }
  const reuse = registry.evaluateObservationReuse({
    scope: context.scope,
    candidateId: observation.candidateId,
    field: observation.field,
    context: context.expectedObservationContext,
  });
  if (reuse.status === 'conflict') {
    return {
      issue: issue(
        'INVALID_EVIDENCE',
        path,
        'fresh observations conflict for this candidate and field',
        [observation.field],
        candidateId ?? undefined,
        [observationId],
      ),
    };
  }
  if (reuse.status === 'expired') {
    return {
      issue: issue(
        'STALE_EVIDENCE',
        path,
        'observation is no longer reusable for this turn',
        ['freshUntil'],
        candidateId ?? undefined,
        [observationId],
      ),
    };
  }
  if (reuse.status === 'context_mismatch' || reuse.status === 'missing') {
    return {
      issue: issue(
        'STALE_EVIDENCE',
        path,
        'observation cannot be reused for this turn context',
        ['context'],
        candidateId ?? undefined,
        [observationId],
      ),
    };
  }
  if (
    observation.sources.length === 0 ||
    !v.safeParse(observationSchema(observation.field), observation.value).success
  ) {
    return {
      issue: issue(
        'INVALID_EVIDENCE',
        path,
        'observation source or value is invalid',
        ['source', observation.field],
        candidateId ?? undefined,
        [observationId],
      ),
    };
  }
  return {
    resolved: {
      observation,
      evidence: {
        observationId: observation.observationId,
        candidateId: observation.candidateId,
        field: observation.field,
        sources: observation.sources,
        retention: observation.retention,
      },
    },
  };
};

export const resolveEvidenceText = (
  text: { text: string; evidenceIds: readonly string[]; basis: EvidenceBasis },
  candidateId: string | null,
  path: string,
  context: SubmitValidationContext,
  registry: CandidateObservationRegistryPort,
  cache: Map<string, ResolvedObservation>,
): SubmitValidationResult<ValidatedEvidenceText> => {
  const evidence: ResolvedObservation[] = [];
  const issues: SubmitValidationIssue[] = [];
  for (const [index, id] of text.evidenceIds.entries()) {
    const cached = cache.get(id);
    if (cached !== undefined) {
      evidence.push(cached);
      continue;
    }
    const resolved = resolveObservation(
      id,
      candidateId,
      `${path}.evidenceIds[${index}]`,
      context,
      registry,
    );
    if (resolved.issue !== undefined) {
      issues.push(resolved.issue);
      continue;
    }
    if (resolved.resolved === undefined) {
      issues.push(issue('INVALID_EVIDENCE', path, 'observation could not be resolved'));
      continue;
    }
    cache.set(id, resolved.resolved);
    evidence.push(resolved.resolved);
  }
  if (issues.length > 0) return invalid(...issues);
  return {
    status: 'valid',
    response: {
      text: text.text,
      evidenceIds: text.evidenceIds,
      basis: text.basis,
      evidence: evidence.map((item) => item.evidence),
    },
  };
};
