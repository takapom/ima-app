import * as v from 'valibot';
import type {
  CardSetRecord,
  ModelContextSource,
  ModelEvidenceSource,
  OriginalTurn,
  RegistryScope,
} from '@ima/core';
import {
  CardSetRecordSchema,
  DetailFieldSchema,
  IsoTimestampSchema,
  ObservationIdSchema,
  OpaqueIdSchema,
  RetentionMetadataSchema,
  SavedPlaceRefSchema,
  Text,
  TurnIdSchema,
} from '@ima/core';
import {
  conversationBodyIsUsable,
  type RetainedHistoryEntry,
} from './runtime-conversation-history';

type CardSetSource = NonNullable<ModelContextSource['cardSet']>;

const HistoryReferenceSchema = v.strictObject({
  threadId: OpaqueIdSchema,
  turnId: TurnIdSchema,
  role: v.picklist(['user', 'assistant']),
  basis: v.picklist(['grounded', 'inference', 'conversational']),
  content: v.optional(
    v.strictObject({
      text: Text(500),
      evidenceIds: v.pipe(v.array(ObservationIdSchema), v.maxLength(32)),
      retention: RetentionMetadataSchema,
    }),
  ),
});
type HistoryReference = v.InferOutput<typeof HistoryReferenceSchema>;

const OriginalTurnReferenceSchema = v.strictObject({
  threadId: OpaqueIdSchema,
  turnId: TurnIdSchema,
});
type OriginalTurnReference = v.InferOutput<typeof OriginalTurnReferenceSchema>;

const EvidenceReferenceSchema = v.strictObject({
  observationId: ObservationIdSchema,
  candidateId: OpaqueIdSchema,
  field: DetailFieldSchema,
  fetchedAt: IsoTimestampSchema,
  freshUntil: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  retention: RetentionMetadataSchema,
});
export const RuntimeProductionCandidateIdentityReferenceSchema = v.strictObject({
  candidateId: OpaqueIdSchema,
  provider: Text(80),
  recordRef: Text(512),
});
export type RuntimeProductionCandidateIdentityReference = v.InferOutput<
  typeof RuntimeProductionCandidateIdentityReferenceSchema
>;

export const RuntimeProductionContextReferenceSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  threadId: OpaqueIdSchema,
  sessionExpiresAt: IsoTimestampSchema,
  savedPlaceRefs: v.pipe(v.array(SavedPlaceRefSchema), v.maxLength(50)),
  /** Owner/thread-bound candidate IDs excluded before a later card-set replacement. */
  excludedCandidateIds: v.optional(v.pipe(v.array(OpaqueIdSchema), v.maxLength(50))),
  history: v.pipe(v.array(HistoryReferenceSchema), v.maxLength(32)),
  originalTurns: v.pipe(v.array(OriginalTurnReferenceSchema), v.maxLength(32)),
  cardSet: v.nullable(CardSetRecordSchema),
  evidence: v.pipe(v.array(EvidenceReferenceSchema), v.maxLength(64)),
  /** Session-only provider identities for the current card set; old snapshots omit this. */
  candidateIdentities: v.optional(
    v.pipe(v.array(RuntimeProductionCandidateIdentityReferenceSchema), v.maxLength(3)),
  ),
});
export type RuntimeProductionContextReference = v.InferOutput<
  typeof RuntimeProductionContextReferenceSchema
>;

export type RuntimeProductionContextPersistence = {
  load(scope: RegistryScope): RuntimeProductionContextReference | undefined;
  save(snapshot: RuntimeProductionContextReference): void;
  clear(scope: RegistryScope): void;
};

export type RuntimeProductionContextStateForReference = {
  readonly history: readonly RetainedHistoryEntry[];
  readonly originalTurns: readonly OriginalTurn[];
  readonly cardSet: CardSetSource | null;
  readonly evidence: readonly ModelEvidenceSource[];
  readonly savedPlaceRefs: readonly string[];
  readonly excludedCandidateIds: readonly string[];
  readonly candidateIdentities: readonly RuntimeProductionCandidateIdentityReference[];
};

export const referenceSnapshotFor = (input: {
  readonly scope: RegistryScope;
  readonly sessionExpiresAt: string;
  readonly state: RuntimeProductionContextStateForReference;
  readonly now?: string;
}): RuntimeProductionContextReference => {
  const cardSet = input.state.cardSet?.record ?? null;
  const cardCandidateIds = new Set(cardSet?.entries.map((entry) => entry.candidateId) ?? []);
  return {
    ownerScopeRef: input.scope.ownerScopeRef,
    threadId: input.scope.threadId,
    sessionExpiresAt: input.sessionExpiresAt,
    savedPlaceRefs: [...input.state.savedPlaceRefs],
    excludedCandidateIds: [...input.state.excludedCandidateIds],
    history: input.state.history.map(
      ({ threadId, turnId, role, basis, text, evidenceIds, retention }) => ({
        threadId,
        turnId,
        role,
        basis,
        ...(retention?.restoreMode === 'full' &&
        input.now !== undefined &&
        conversationBodyIsUsable(retention, input.now)
          ? { content: { text, evidenceIds: [...evidenceIds], retention } }
          : {}),
      }),
    ),
    originalTurns: input.state.originalTurns.map(({ threadId, turnId }) => ({
      threadId,
      turnId,
    })),
    cardSet,
    evidence: input.state.evidence.map(
      ({ observationId, candidateId, field, fetchedAt, freshUntil, expiresAt, retention }) => ({
        observationId,
        candidateId,
        field,
        fetchedAt,
        freshUntil,
        expiresAt,
        retention,
      }),
    ),
    candidateIdentities: input.state.candidateIdentities.filter((identity) =>
      cardCandidateIds.has(identity.candidateId),
    ),
  };
};

const restoredHistory = (
  { content, ...reference }: HistoryReference,
  now: string,
): RetainedHistoryEntry =>
  content?.retention.restoreMode === 'full' && conversationBodyIsUsable(content.retention, now)
    ? { ...reference, ...content }
    : { ...reference, basis: 'conversational', text: '[withheld]', evidenceIds: [] };

const withheldOriginalTurn = (reference: OriginalTurnReference): OriginalTurn => ({
  ...reference,
  text: '[withheld]',
});

const withheldCardSet = (record: CardSetRecord): CardSetSource => ({
  record: {
    ...record,
    entries: record.entries.map((entry) => ({ ...entry })),
    excludedCandidateIds: [...record.excludedCandidateIds],
  },
  candidates: record.entries.map((entry) => ({
    candidateId: entry.candidateId,
    ownerScopeRef: record.scope.ownerScopeRef,
    threadId: record.scope.threadId,
    displayName: '[withheld]',
    status: 'unknown',
    excluded: record.excludedCandidateIds.includes(entry.candidateId),
  })),
});

export const stateFromReference = (snapshot: RuntimeProductionContextReference, now: string) => {
  const history = snapshot.history.map((entry) => restoredHistory(entry, now));
  return {
    history,
    originalTurns: snapshot.originalTurns.map((reference) => ({
      ...withheldOriginalTurn(reference),
      text:
        history.find(
          (entry) =>
            entry.role === 'user' &&
            entry.threadId === reference.threadId &&
            entry.turnId === reference.turnId,
        )?.text ?? '[withheld]',
    })),
    cardSet: snapshot.cardSet === null ? null : withheldCardSet(snapshot.cardSet),
    evidence: [],
    savedPlaceRefs: [...snapshot.savedPlaceRefs],
    excludedCandidateIds: [...(snapshot.excludedCandidateIds ?? [])],
    candidateIdentities: [...(snapshot.candidateIdentities ?? [])],
    cardSetReferenceOnly: snapshot.cardSet !== null,
  };
};

export const candidateIdentityForReference = (input: {
  readonly snapshot: RuntimeProductionContextReference | undefined;
  readonly scope: RegistryScope;
  readonly candidateId: string;
  readonly now: string;
}): RuntimeProductionCandidateIdentityReference | undefined => {
  const snapshot = input.snapshot;
  if (
    snapshot === undefined ||
    snapshot.ownerScopeRef !== input.scope.ownerScopeRef ||
    snapshot.threadId !== input.scope.threadId ||
    snapshot.cardSet === null ||
    snapshot.cardSet.scope.ownerScopeRef !== input.scope.ownerScopeRef ||
    snapshot.cardSet.scope.threadId !== input.scope.threadId
  ) {
    return undefined;
  }
  const now = Date.parse(input.now);
  const expiresAt = Date.parse(snapshot.sessionExpiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || now >= expiresAt) return undefined;
  if (
    snapshot.cardSet.excludedCandidateIds.includes(input.candidateId) ||
    (snapshot.excludedCandidateIds ?? []).includes(input.candidateId) ||
    !snapshot.cardSet.entries.some((entry) => entry.candidateId === input.candidateId)
  ) {
    return undefined;
  }
  const identity = (snapshot.candidateIdentities ?? []).find(
    (candidate) => candidate.candidateId === input.candidateId,
  );
  return identity === undefined ? undefined : { ...identity };
};

export const parseRuntimeProductionContextReference = (
  value: unknown,
): RuntimeProductionContextReference | undefined => {
  const parsed = v.safeParse(RuntimeProductionContextReferenceSchema, value);
  if (!parsed.success) return undefined;
  const identities = parsed.output.candidateIdentities ?? [];
  const currentCandidateIds = new Set(
    parsed.output.cardSet?.entries.map((entry) => entry.candidateId) ?? [],
  );
  if (
    new Set(identities.map((identity) => identity.candidateId)).size !== identities.length ||
    identities.some((identity) => !currentCandidateIds.has(identity.candidateId))
  ) {
    return undefined;
  }
  return parsed.output;
};
