import * as v from 'valibot';
import type {
  CardSetRecord,
  ModelContextSource,
  ModelEvidenceSource,
  ModelHistoryEntry,
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
  TurnIdSchema,
} from '@ima/core';

type CardSetSource = NonNullable<ModelContextSource['cardSet']>;

const HistoryReferenceSchema = v.strictObject({
  threadId: OpaqueIdSchema,
  turnId: TurnIdSchema,
  role: v.picklist(['user', 'assistant']),
  basis: v.picklist(['grounded', 'inference', 'conversational']),
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
export const RuntimeProductionContextReferenceSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  threadId: OpaqueIdSchema,
  sessionExpiresAt: IsoTimestampSchema,
  savedPlaceRefs: v.pipe(v.array(SavedPlaceRefSchema), v.maxLength(50)),
  history: v.pipe(v.array(HistoryReferenceSchema), v.maxLength(32)),
  originalTurns: v.pipe(v.array(OriginalTurnReferenceSchema), v.maxLength(32)),
  cardSet: v.nullable(CardSetRecordSchema),
  evidence: v.pipe(v.array(EvidenceReferenceSchema), v.maxLength(64)),
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
  readonly history: readonly ModelHistoryEntry[];
  readonly originalTurns: readonly OriginalTurn[];
  readonly cardSet: CardSetSource | null;
  readonly evidence: readonly ModelEvidenceSource[];
  readonly savedPlaceRefs: readonly string[];
};

export const referenceSnapshotFor = (input: {
  readonly scope: RegistryScope;
  readonly sessionExpiresAt: string;
  readonly state: RuntimeProductionContextStateForReference;
}): RuntimeProductionContextReference => {
  const cardSet = input.state.cardSet?.record ?? null;
  return {
    ownerScopeRef: input.scope.ownerScopeRef,
    threadId: input.scope.threadId,
    sessionExpiresAt: input.sessionExpiresAt,
    savedPlaceRefs: [...input.state.savedPlaceRefs],
    history: input.state.history.map(({ threadId, turnId, role, basis }) => ({
      threadId,
      turnId,
      role,
      basis,
    })),
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
  };
};

const withheldHistory = (reference: HistoryReference): ModelHistoryEntry => ({
  ...reference,
  basis: reference.basis === 'grounded' ? 'conversational' : reference.basis,
  text: '[withheld]',
  evidenceIds: [],
});

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

export const stateFromReference = (snapshot: RuntimeProductionContextReference) => ({
  history: snapshot.history.map(withheldHistory),
  originalTurns: snapshot.originalTurns.map(withheldOriginalTurn),
  cardSet: snapshot.cardSet === null ? null : withheldCardSet(snapshot.cardSet),
  evidence: [],
  savedPlaceRefs: [...snapshot.savedPlaceRefs],
  cardSetReferenceOnly: snapshot.cardSet !== null,
});

export const parseRuntimeProductionContextReference = (
  value: unknown,
): RuntimeProductionContextReference | undefined => {
  const parsed = v.safeParse(RuntimeProductionContextReferenceSchema, value);
  return parsed.success ? parsed.output : undefined;
};
