import * as v from 'valibot';
import {
  CandidateStatusSchema,
  CardSetRecordSchema,
  type CandidateStatus,
  type CardSetRecord,
} from '../domain';
import {
  CandidateIdSchema,
  ObservationIdSchema,
  OpaqueIdSchema,
  SavedPlaceRefSchema,
  Text,
  TurnIdSchema,
} from '../domain/primitives';
import type { HarnessContext } from '../ports/context';
import { HarnessContextSchema } from '../ports/context';
import { TurnConditionValuesSchema, type TurnConditionValues } from './turn-constraints';
import { ModelContextError } from './model-context-errors';
import {
  ModelEvidenceSourceSchema,
  projectModelEvidenceForLlmInput,
  type ModelEvidence,
} from './model-evidence';
import {
  denyModelContextFieldPolicy,
  ModelContextFieldPolicySchema,
  modelContextFieldAllowed,
  modelEvidenceFieldDecision,
} from './model-context-policy';
import type { ModelContextFieldPolicy } from './model-context-policy';

export {
  evaluateModelEvidenceAvailability,
  evaluateModelEvidenceAvailabilityForLlmInput,
  ModelEvidenceSourceSchema,
  projectModelEvidence,
  projectModelEvidenceForLlmInput,
} from './model-evidence';
export type {
  ModelEvidenceAvailability,
  ModelEvidenceAvailabilityInput,
  ModelEvidence,
  ModelEvidenceSource,
} from './model-evidence';
export {
  denyModelContextFieldPolicy,
  ModelContextFieldDecisionSchema,
  ModelContextFieldPolicySchema,
  modelContextFieldAllowed,
  modelEvidenceFieldDecision,
} from './model-context-policy';
export type { ModelContextFieldDecision, ModelContextFieldPolicy } from './model-context-policy';
export { ModelContextError } from './model-context-errors';
export type { ModelContextErrorCode } from './model-context-errors';

const EvidenceIdsSchema = v.pipe(
  v.array(ObservationIdSchema),
  v.maxLength(16),
  v.check((ids) => new Set(ids).size === ids.length, 'duplicate evidence ID'),
);

const MessageBasisSchema = v.picklist(['grounded', 'inference', 'conversational']);

export const ModelHistoryEntrySchema = v.pipe(
  v.strictObject({
    threadId: OpaqueIdSchema,
    turnId: TurnIdSchema,
    role: v.picklist(['user', 'assistant']),
    text: Text(500),
    evidenceIds: EvidenceIdsSchema,
    basis: MessageBasisSchema,
  }),
  v.check(
    (entry) => entry.basis !== 'grounded' || entry.evidenceIds.length > 0,
    'grounded history requires evidence',
  ),
);
export type ModelHistoryEntry = v.InferOutput<typeof ModelHistoryEntrySchema>;

const ModelCandidateSourceSchema = v.strictObject({
  candidateId: CandidateIdSchema,
  ownerScopeRef: OpaqueIdSchema,
  threadId: OpaqueIdSchema,
  displayName: Text(160),
  status: CandidateStatusSchema,
  excluded: v.boolean(),
});
export type ModelCandidateSource = v.InferOutput<typeof ModelCandidateSourceSchema>;

const ModelCardSetSourceSchema = v.strictObject({
  record: CardSetRecordSchema,
  candidates: v.pipe(v.array(ModelCandidateSourceSchema), v.maxLength(3)),
});

const ModelStationOptionSchema = v.strictObject({
  stationRef: OpaqueIdSchema,
  displayName: Text(160),
});

export const ModelStationDirectorySchema = v.union([
  v.pipe(
    v.strictObject({
      status: v.literal('available'),
      stations: v.pipe(v.array(ModelStationOptionSchema), v.minLength(1), v.maxLength(32)),
    }),
    v.check(
      (directory) =>
        new Set(directory.stations.map((station) => station.stationRef)).size ===
        directory.stations.length,
      'station directory references must be unique',
    ),
  ),
  v.strictObject({
    status: v.picklist(['unknown', 'unsupported']),
    reason: Text(200),
  }),
]);
export type ModelStationDirectory = v.InferOutput<typeof ModelStationDirectorySchema>;

/** Model may select an owner-scoped reference, but never receives provider identity or payload. */
export const ModelSavedReferenceSchema = v.strictObject({
  savedPlaceRef: SavedPlaceRefSchema,
});
export type ModelSavedReference = v.InferOutput<typeof ModelSavedReferenceSchema>;

const ModelSavedReferencesSchema = v.pipe(
  v.array(ModelSavedReferenceSchema),
  v.maxLength(50),
  v.check(
    (references) =>
      new Set(references.map((reference) => reference.savedPlaceRef)).size === references.length,
    'saved references must be unique',
  ),
);

export const ModelContextSourceSchema = v.strictObject({
  harness: HarnessContextSchema,
  userText: Text(500),
  history: v.pipe(v.array(ModelHistoryEntrySchema), v.maxLength(32)),
  cardSet: v.nullable(ModelCardSetSourceSchema),
  conditions: TurnConditionValuesSchema,
  evidence: v.pipe(v.array(ModelEvidenceSourceSchema), v.maxLength(64)),
  /** Optional for older callers; production supplies the current opaque owner references. */
  savedReferences: v.optional(ModelSavedReferencesSchema),
  stationDirectory: v.optional(ModelStationDirectorySchema),
  /** Optional for older Core callers; Worker production composition supplies an explicit policy. */
  fieldPolicy: v.optional(ModelContextFieldPolicySchema),
});
export type ModelContextSource = v.InferOutput<typeof ModelContextSourceSchema>;

export type ModelCandidate = {
  readonly candidateId: string;
  readonly displayName: string;
  readonly status: CandidateStatus;
};

export type ModelCardSet = {
  readonly cardSetId: string;
  readonly responseId: string;
  readonly entries: CardSetRecord['entries'];
  readonly candidates: readonly ModelCandidate[];
  readonly selectedCandidateId: string | null;
  readonly excludedCandidateIds: readonly string[];
};

export type ProjectedModelContext = {
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly serverNow: string;
  readonly userText: string;
  readonly location: {
    readonly status: HarnessContext['location']['status'];
    readonly areaDescription: string | null;
  };
  readonly preferences: HarnessContext['preferences'];
  readonly conditions: TurnConditionValues;
  readonly savedReferences: readonly ModelSavedReference[];
  readonly stationDirectory: ModelStationDirectory;
  readonly history: readonly Omit<ModelHistoryEntry, 'threadId'>[];
  readonly cardSet: ModelCardSet | null;
  readonly evidence: readonly ModelEvidence[];
  readonly capabilities: HarnessContext['capabilities'];
  readonly budget: HarnessContext['budget'];
};

const projectCardSet = (
  source: NonNullable<ModelContextSource['cardSet']>,
  harness: HarnessContext,
  displayNameDecision: ModelContextFieldPolicy['displayName'],
): ModelCardSet => {
  const { record, candidates } = source;
  if (
    record.scope.ownerScopeRef !== harness.ownerScopeRef ||
    record.scope.threadId !== harness.threadId
  ) {
    throw new ModelContextError('SCOPE_MISMATCH', 'card set is outside the current thread');
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const cardCandidates = record.entries.map((entry) => {
    const candidate = candidateById.get(entry.candidateId);
    if (candidate === undefined) {
      throw new ModelContextError('CARD_SET_MISMATCH', 'card set candidate is missing');
    }
    if (
      candidate.ownerScopeRef !== harness.ownerScopeRef ||
      candidate.threadId !== harness.threadId
    ) {
      throw new ModelContextError('SCOPE_MISMATCH', 'candidate is outside the current thread');
    }
    const excluded = record.excludedCandidateIds.includes(candidate.candidateId);
    if (candidate.excluded !== excluded) {
      throw new ModelContextError('CARD_SET_MISMATCH', 'candidate exclusion state is inconsistent');
    }
    return {
      candidateId: candidate.candidateId,
      displayName: modelContextFieldAllowed(displayNameDecision)
        ? candidate.displayName
        : '[withheld]',
      status: candidate.status,
    };
  });
  if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) {
    throw new ModelContextError('CARD_SET_MISMATCH', 'card set candidates are duplicated');
  }
  return {
    cardSetId: record.cardSetId,
    responseId: record.responseId,
    entries: record.entries,
    candidates: cardCandidates,
    selectedCandidateId: record.selectedCandidateId,
    excludedCandidateIds: record.excludedCandidateIds,
  };
};

/** Builds the Core-to-model context without owner or coordinate data. */
export const projectModelContext = (source: unknown): ProjectedModelContext => {
  const parsed = v.safeParse(ModelContextSourceSchema, source);
  if (!parsed.success) throw new ModelContextError('INVALID_CONTEXT', 'model context is invalid');
  const value = parsed.output;
  const fieldPolicy = value.fieldPolicy ?? denyModelContextFieldPolicy;
  const harness = value.harness;
  for (const entry of value.history) {
    if (entry.threadId !== harness.threadId) {
      throw new ModelContextError('SCOPE_MISMATCH', 'history entry is outside the current thread');
    }
  }
  for (const evidence of value.evidence) {
    if (
      evidence.ownerScopeRef !== harness.ownerScopeRef ||
      evidence.threadId !== harness.threadId
    ) {
      throw new ModelContextError('SCOPE_MISMATCH', 'evidence is outside the current thread');
    }
  }
  if (
    new Set(value.evidence.map((evidence) => evidence.observationId)).size !== value.evidence.length
  ) {
    throw new ModelContextError('INVALID_EVIDENCE', 'evidence observation IDs are duplicated');
  }
  const projectedEvidence = value.evidence.map((evidence) => {
    const projected = projectModelEvidenceForLlmInput(evidence, harness.serverNow);
    if (projected.status !== 'known') return projected;
    return modelContextFieldAllowed(modelEvidenceFieldDecision(fieldPolicy, evidence.field))
      ? projected
      : {
          status: 'withheld' as const,
          observationId: projected.observationId,
          candidateId: projected.candidateId,
          field: projected.field,
          reason: 'model input policy denies this evidence field',
          freshUntil: projected.freshUntil,
        };
  });
  const usableEvidenceIds = new Set(
    projectedEvidence.flatMap((evidence) =>
      evidence.status === 'known' ? [evidence.observationId] : [],
    ),
  );
  return {
    threadId: harness.threadId,
    turnId: harness.turnId,
    revision: harness.revision,
    serverNow: harness.serverNow,
    userText: value.userText,
    location: {
      status: harness.location.status,
      areaDescription: harness.preferences.areaText,
    },
    preferences: harness.preferences,
    conditions: value.conditions,
    savedReferences: value.savedReferences ?? [],
    stationDirectory: value.stationDirectory ?? {
      status: 'unknown',
      reason: 'station directory was not supplied',
    },
    history: modelContextFieldAllowed(fieldPolicy.history)
      ? value.history
          .filter((entry) => entry.evidenceIds.every((id) => usableEvidenceIds.has(id)))
          .map(({ threadId: _threadId, ...entry }) => entry)
      : [],
    cardSet:
      value.cardSet === null || !modelContextFieldAllowed(fieldPolicy.cardSet)
        ? null
        : projectCardSet(value.cardSet, harness, fieldPolicy.displayName),
    evidence: projectedEvidence,
    capabilities: harness.capabilities,
    budget: harness.budget,
  };
};
