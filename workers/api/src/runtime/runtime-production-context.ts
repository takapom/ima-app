import * as v from 'valibot';
import type { AssistantResponse, ThreadTurnRequest } from '@ima/contracts';
import { AssistantResponseSchema } from '@ima/contracts';
import type {
  CandidateObservationRegistryPort,
  ConstraintValidationContext,
  ModelContextFieldPolicy,
  ModelContextSource,
  ModelEvidenceSource,
  ModelHistoryEntry,
  OriginalTurn,
  RegistryScope,
} from '@ima/core';
import {
  CardSetRecordSchema,
  DetailFieldSchema,
  ModelEvidenceSourceSchema,
  ModelHistoryEntrySchema,
  OriginalTurnSchema,
} from '@ima/core';
import type { RuntimeThinkComposition } from './runtime-think-connection';

type CardSetSource = NonNullable<ModelContextSource['cardSet']>;

export type RuntimeProductionModelContext = Pick<
  ModelContextSource,
  'userText' | 'history' | 'cardSet' | 'evidence' | 'fieldPolicy'
>;

type ProductionContextState = {
  readonly history: readonly ModelHistoryEntry[];
  readonly originalTurns: readonly OriginalTurn[];
  readonly cardSet: CardSetSource | null;
  readonly evidence: readonly ModelEvidenceSource[];
  readonly savedPlaceRefs: readonly string[];
};

type PendingTurn = {
  readonly key: string;
  readonly input: ThreadTurnRequest;
  readonly scope: RegistryScope;
  readonly base: ProductionContextState;
  readonly cardSet: CardSetSource | null;
};

export type RuntimeProductionContextStore = {
  beginTurn(
    input: ThreadTurnRequest,
    scope: RegistryScope,
    fieldPolicy: ModelContextFieldPolicy,
  ): {
    readonly modelContext: RuntimeProductionModelContext;
    readonly constraintContext: ConstraintValidationContext;
  };
  commitTurn(input: ThreadTurnRequest, response: unknown): void;
  snapshot(): {
    readonly history: readonly ModelHistoryEntry[];
    readonly originalTurns: readonly OriginalTurn[];
    readonly cardSet: CardSetSource | null;
    readonly evidence: readonly ModelEvidenceSource[];
    readonly savedPlaceRefs: readonly string[];
  };
};

export const wrapRuntimeProductionCommit = <Response>(
  composition: RuntimeThinkComposition<Response>,
  onCommitted: (response: Response) => void,
): RuntimeThinkComposition<Response> => ({
  ...composition,
  getCommittedResponse: async () => {
    const response = await composition.getCommittedResponse();
    if (response !== undefined) onCommitted(response);
    return response;
  },
});

const turnKey = (scope: RegistryScope, input: ThreadTurnRequest): string =>
  JSON.stringify({
    ownerScopeRef: scope.ownerScopeRef,
    threadId: scope.threadId,
    requestId: input.requestId,
    turnId: input.turnId,
    revision: input.revision,
    text: input.text,
    clientNow: input.clientNow,
    location: input.location,
    prefs: input.prefs,
    savedPlaceRefs: input.savedPlaceRefs,
    excludeCandidateIds: input.excludeCandidateIds,
    mode: input.mode,
    idempotencyKey: input.idempotencyKey,
  });

const appendBounded = <T>(items: readonly T[], next: readonly T[], max: number): readonly T[] =>
  [...items, ...next].slice(-max);

const unique = (items: readonly string[]): readonly string[] => [...new Set(items)];

const copyCardSet = (cardSet: CardSetSource | null): CardSetSource | null =>
  cardSet === null ? null : structuredClone(cardSet);

const copyState = (state: ProductionContextState): ProductionContextState => ({
  history: structuredClone(state.history),
  originalTurns: structuredClone(state.originalTurns),
  cardSet: copyCardSet(state.cardSet),
  evidence: structuredClone(state.evidence),
  savedPlaceRefs: [...state.savedPlaceRefs],
});

const responseEvidenceIds = (response: AssistantResponse): readonly string[] => {
  const ids: string[] = [];
  for (const message of response.message) ids.push(...message.evidenceIds);
  if (response.kind !== 'cards') return unique(ids);
  for (const card of [response.cards.hero, ...response.cards.alts]) {
    ids.push(...card.why.evidenceIds);
    if (card.diff !== undefined) ids.push(...card.diff.evidenceIds);
    for (const field of Object.values(card.facts)) {
      if (field?.status === 'known') {
        ids.push(...field.evidence.map((evidence) => evidence.evidenceId));
      }
    }
  }
  return unique(ids);
};

const responseHistory = (response: AssistantResponse): readonly ModelHistoryEntry[] =>
  response.message.flatMap((message) => {
    const parsed = v.safeParse(ModelHistoryEntrySchema, {
      threadId: response.threadId,
      turnId: response.turnId,
      role: 'assistant',
      text: message.text,
      evidenceIds: message.evidenceIds,
      basis: message.basis,
    });
    return parsed.success ? [parsed.output] : [];
  });

const evidenceSourceFor = (
  registry: CandidateObservationRegistryPort,
  scope: RegistryScope,
  observationId: string,
): ModelEvidenceSource | undefined => {
  const observation = registry.readObservation(scope, observationId);
  if (
    observation === undefined ||
    observation.context.ownerScopeRef !== scope.ownerScopeRef ||
    observation.context.threadId !== scope.threadId
  )
    return undefined;
  const field = v.safeParse(DetailFieldSchema, observation.field);
  if (!field.success) return undefined;
  const parsed = v.safeParse(ModelEvidenceSourceSchema, {
    ownerScopeRef: scope.ownerScopeRef,
    threadId: scope.threadId,
    observationId: observation.observationId,
    candidateId: observation.candidateId,
    field: field.output,
    value: observation.value,
    fetchedAt: observation.fetchedAt,
    freshUntil: observation.freshUntil,
    expiresAt: observation.expiresAt,
    sources: observation.sources,
    retention: observation.retention,
  });
  return parsed.success ? parsed.output : undefined;
};

const candidateSourceFor = (
  registry: CandidateObservationRegistryPort,
  scope: RegistryScope,
  record: NonNullable<CardSetSource['record']>,
): CardSetSource['candidates'] | undefined => {
  const excluded = new Set(record.excludedCandidateIds);
  const candidates = record.entries.map((entry) =>
    registry.readCandidate(scope, entry.candidateId),
  );
  if (candidates.some((candidate) => candidate === undefined)) return undefined;
  return candidates.map((candidate) => {
    if (candidate === undefined) throw new Error('candidate disappeared while projecting context');
    if (candidate.ownerScopeRef !== scope.ownerScopeRef || candidate.threadId !== scope.threadId) {
      throw new Error('candidate scope changed while projecting context');
    }
    return {
      candidateId: candidate.candidateId,
      ownerScopeRef: candidate.ownerScopeRef,
      threadId: candidate.threadId,
      displayName: candidate.displayName,
      status: candidate.status,
      excluded: excluded.has(candidate.candidateId) || candidate.excluded,
    };
  });
};

const cardSetFor = (
  registry: CandidateObservationRegistryPort,
  scope: RegistryScope,
  record: CardSetSource['record'],
): CardSetSource | null => {
  const candidates = candidateSourceFor(registry, scope, record);
  if (candidates === undefined) return null;
  const excluded = unique([
    ...record.excludedCandidateIds,
    ...candidates
      .filter((candidate) => candidate.excluded)
      .map((candidate) => candidate.candidateId),
  ]);
  const selectedCandidateId =
    record.selectedCandidateId !== null && excluded.includes(record.selectedCandidateId)
      ? null
      : record.selectedCandidateId;
  const parsed = v.safeParse(CardSetRecordSchema, {
    ...record,
    selectedCandidateId,
    excludedCandidateIds: excluded,
  });
  return parsed.success ? { record: parsed.output, candidates } : null;
};

const stagedCardSetFor = (
  registry: CandidateObservationRegistryPort,
  scope: RegistryScope,
  previous: CardSetSource | null,
  excludedCandidateIds: readonly string[],
): CardSetSource | null => {
  if (previous === null) return null;
  const entryIds = new Set(previous.record.entries.map((entry) => entry.candidateId));
  const excluded = unique([
    ...previous.record.excludedCandidateIds,
    ...excludedCandidateIds.filter((candidateId) => entryIds.has(candidateId)),
  ]);
  const selectedCandidateId =
    previous.record.selectedCandidateId !== null &&
    excluded.includes(previous.record.selectedCandidateId)
      ? null
      : previous.record.selectedCandidateId;
  const parsed = v.safeParse(CardSetRecordSchema, {
    ...previous.record,
    selectedCandidateId,
    excludedCandidateIds: excluded,
  });
  return parsed.success ? cardSetFor(registry, scope, parsed.output) : null;
};

const cardSetFromResponse = (
  registry: CandidateObservationRegistryPort,
  scope: RegistryScope,
  response: Extract<AssistantResponse, { kind: 'cards' }>,
): CardSetSource | null => {
  const candidates = [response.cards.hero, ...response.cards.alts];
  const parsed = v.safeParse(CardSetRecordSchema, {
    cardSetId: response.cardSetId,
    scope,
    responseId: response.responseId,
    entries: candidates.map((candidate, displayOrder) => ({
      candidateId: candidate.candidateId,
      displayOrder,
      role: displayOrder === 0 ? 'hero' : 'alt',
    })),
    selectedCandidateId: null,
    excludedCandidateIds: [],
  });
  if (!parsed.success) return null;
  return cardSetFor(registry, scope, parsed.output);
};

const userHistoryFor = (
  input: ThreadTurnRequest,
  scope: RegistryScope,
): ModelHistoryEntry | undefined => {
  const parsed = v.safeParse(ModelHistoryEntrySchema, {
    threadId: scope.threadId,
    turnId: input.turnId ?? input.requestId,
    role: 'user',
    text: input.text,
    evidenceIds: [],
    basis: 'conversational',
  });
  return parsed.success ? parsed.output : undefined;
};

const originalTurnFor = (
  input: ThreadTurnRequest,
  scope: RegistryScope,
): OriginalTurn | undefined => {
  const parsed = v.safeParse(OriginalTurnSchema, {
    threadId: scope.threadId,
    turnId: input.turnId ?? input.requestId,
    text: input.text,
  });
  return parsed.success ? parsed.output : undefined;
};

const replaceByTurn = (
  turns: readonly OriginalTurn[],
  next: OriginalTurn,
): readonly OriginalTurn[] =>
  [
    ...turns.filter((turn) => !(turn.threadId === next.threadId && turn.turnId === next.turnId)),
    next,
  ].slice(-32);

export const createRuntimeProductionContextStore = (input: {
  readonly registry: CandidateObservationRegistryPort;
}): RuntimeProductionContextStore => {
  const scopeFor = (scope: RegistryScope): RegistryScope => ({ ...scope });
  let state: ProductionContextState = {
    history: [],
    originalTurns: [],
    cardSet: null,
    evidence: [],
    savedPlaceRefs: [],
  };
  let pending: PendingTurn | undefined;
  let boundScope: RegistryScope | undefined;

  const beginTurn = (
    request: ThreadTurnRequest,
    scope: RegistryScope,
    fieldPolicy: ModelContextFieldPolicy,
  ) => {
    const safeScope = scopeFor(scope);
    if (
      boundScope !== undefined &&
      (boundScope.ownerScopeRef !== safeScope.ownerScopeRef ||
        boundScope.threadId !== safeScope.threadId)
    ) {
      throw new Error('RUNTIME_CONTEXT_SCOPE_MISMATCH');
    }
    boundScope ??= safeScope;
    const cardSet = stagedCardSetFor(
      input.registry,
      safeScope,
      copyCardSet(state.cardSet),
      request.excludeCandidateIds,
    );
    pending = {
      key: turnKey(safeScope, request),
      input: structuredClone(request),
      scope: safeScope,
      base: copyState(state),
      cardSet,
    };
    return {
      modelContext: {
        userText: request.text,
        history: [...structuredClone(state.history)],
        cardSet,
        evidence: [...structuredClone(state.evidence)],
        fieldPolicy,
      },
      constraintContext: {
        threadId: safeScope.threadId,
        originalTurns: [...structuredClone(state.originalTurns)],
      },
    };
  };

  const commitTurn = (request: ThreadTurnRequest, value: unknown): void => {
    const active = pending;
    if (active === undefined || turnKey(active.scope, request) !== active.key) return;
    const parsed = v.safeParse(AssistantResponseSchema, value);
    if (
      !parsed.success ||
      parsed.output.threadId !== active.scope.threadId ||
      parsed.output.turnId !== (active.input.turnId ?? active.input.requestId) ||
      parsed.output.revision !== active.input.revision + 1
    )
      return;

    const responseCardSet =
      parsed.output.kind === 'cards'
        ? cardSetFromResponse(input.registry, active.scope, parsed.output)
        : active.cardSet;
    if (parsed.output.kind === 'cards' && responseCardSet === null) return;
    const nextCardSet =
      parsed.output.kind === 'cards'
        ? stagedCardSetFor(
            input.registry,
            active.scope,
            responseCardSet,
            active.input.excludeCandidateIds,
          )
        : responseCardSet;
    if (parsed.output.kind === 'cards' && nextCardSet === null) return;
    const userHistory = userHistoryFor(active.input, active.scope);
    const originalTurn = originalTurnFor(active.input, active.scope);
    if (userHistory === undefined || originalTurn === undefined) return;
    const assistantHistory = responseHistory(parsed.output);
    const evidence = responseEvidenceIds(parsed.output)
      .map((observationId) => evidenceSourceFor(input.registry, active.scope, observationId))
      .filter((source): source is ModelEvidenceSource => source !== undefined);
    const byEvidenceId = new Map(
      active.base.evidence.map((source) => [source.observationId, source]),
    );
    for (const source of evidence) byEvidenceId.set(source.observationId, source);
    for (const candidateId of active.input.excludeCandidateIds) {
      const candidate = input.registry.readCandidate(active.scope, candidateId);
      if (candidate === undefined) return;
    }
    try {
      for (const candidateId of active.input.excludeCandidateIds) {
        const candidate = input.registry.readCandidate(active.scope, candidateId);
        if (candidate !== undefined && !candidate.excluded) {
          input.registry.excludeCandidate(active.scope, candidateId);
        }
      }
    } catch {
      return;
    }
    state = {
      history: appendBounded(active.base.history, [userHistory, ...assistantHistory], 32),
      originalTurns: replaceByTurn(active.base.originalTurns, originalTurn),
      cardSet: nextCardSet,
      evidence: [...byEvidenceId.values()].slice(-64),
      savedPlaceRefs: [...active.input.savedPlaceRefs],
    };
    pending = undefined;
  };

  return {
    beginTurn,
    commitTurn,
    snapshot: () => ({
      history: structuredClone(state.history),
      originalTurns: structuredClone(state.originalTurns),
      cardSet: copyCardSet(state.cardSet),
      evidence: structuredClone(state.evidence),
      savedPlaceRefs: [...state.savedPlaceRefs],
    }),
  };
};
