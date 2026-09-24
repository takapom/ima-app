import {
  ConversationMemorySchema,
  projectConversationMemory,
  type ProjectedConversationMemory,
} from '@worker/application/model-context/conversation-memory';
import * as v from 'valibot';
import { CandidateStatusSchema, type CandidateStatus } from '@worker/domain/candidates/registry';
import { CardSetRecordSchema, type CardSetRecord } from '@worker/domain/candidates/continuity';
import {
  CandidateIdSchema,
  ObservationIdSchema,
  OpaqueIdSchema,
  Text,
  TurnIdSchema,
} from '@worker/domain/primitives';
import type { HarnessContext } from '@worker/application/ports/context';
import { HarnessContextSchema } from '@worker/application/ports/context';
import { ModelContextError } from '@worker/application/model-context/model-context-errors';
import {
  ModelEvidenceSourceSchema,
  projectModelEvidenceForLlmInput,
  type ModelEvidence,
} from '@worker/application/model-context/model-evidence';
import {
  denyModelContextFieldPolicy,
  ModelContextFieldPolicySchema,
  modelContextFieldAllowed,
  modelEvidenceFieldDecision,
} from '@worker/application/model-context/model-context-policy';
import type { ModelContextFieldPolicy } from '@worker/application/model-context/model-context-policy';

export {
  evaluateModelEvidenceAvailability,
  evaluateModelEvidenceAvailabilityForLlmInput,
  ModelEvidenceSourceSchema,
  projectModelEvidence,
  projectModelEvidenceForLlmInput,
} from '@worker/application/model-context/model-evidence';
export type {
  ModelEvidenceAvailability,
  ModelEvidenceAvailabilityInput,
  ModelEvidence,
  ModelEvidenceSource,
} from '@worker/application/model-context/model-evidence';
export {
  denyModelContextFieldPolicy,
  ModelContextFieldDecisionSchema,
  ModelContextFieldPolicySchema,
  modelContextFieldAllowed,
  modelEvidenceFieldDecision,
} from '@worker/application/model-context/model-context-policy';
export type {
  ModelContextFieldDecision,
  ModelContextFieldPolicy,
} from '@worker/application/model-context/model-context-policy';
export { ModelContextError } from '@worker/application/model-context/model-context-errors';
export type { ModelContextErrorCode } from '@worker/application/model-context/model-context-errors';

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

export const ModelContextSourceSchema = v.strictObject({
  harness: HarnessContextSchema,
  conversationMemory: v.optional(ConversationMemorySchema),
  userText: Text(500),
  history: v.pipe(v.array(ModelHistoryEntrySchema), v.maxLength(32)),
  cardSet: v.nullable(ModelCardSetSourceSchema),
  evidence: v.pipe(v.array(ModelEvidenceSourceSchema), v.maxLength(64)),
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
  readonly conversationMemory?: ProjectedConversationMemory;
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
    ...(value.conversationMemory === undefined
      ? {}
      : {
          conversationMemory: projectConversationMemory(
            {
              ...value.conversationMemory,
              summary: modelContextFieldAllowed(fieldPolicy.history)
                ? (value.conversationMemory.summary ?? null)
                : null,
              entries: modelContextFieldAllowed(fieldPolicy.history)
                ? value.conversationMemory.entries
                : [],
            },
            harness.ownerScopeRef,
            harness.serverNow,
          ),
        }),
    location: {
      status: harness.location.status,
      areaDescription: harness.preferences.areaText,
    },
    preferences: harness.preferences,
    history: modelContextFieldAllowed(fieldPolicy.history)
      ? value.history.map(({ threadId: _threadId, ...entry }) =>
          entry.evidenceIds.every((id) => usableEvidenceIds.has(id))
            ? entry
            : { ...entry, evidenceIds: [], basis: 'conversational' },
        )
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
