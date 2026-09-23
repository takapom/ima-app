import * as v from 'valibot';
import type { AssistantResponse, ThreadTurnRequest } from '@ima/contracts';
import { AssistantResponseSchema } from '@ima/contracts';
import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type { ModelContextFieldPolicy } from '@worker/application/model-context/model-context-policy';
import type {
  ModelContextSource,
  ModelHistoryEntry,
} from '@worker/application/model-context/model-context';
import type { ModelEvidenceSource } from '@worker/application/model-context/model-evidence';
import type { RegistryScope } from '@worker/domain/evidence/freshness';
import { CardSetRecordSchema } from '@worker/domain/candidates/continuity';
import { DetailFieldSchema } from '@worker/domain/primitives';
import { ModelEvidenceSourceSchema } from '@worker/application/model-context/model-evidence';
import type { RuntimeThinkComposition } from '@worker/runtime/turn-execution/runtime-think-connection';
import {
  referenceSnapshotFor,
  stateFromReference,
  type RuntimeProductionCandidateIdentityReference,
  type RuntimeProductionContextPersistence,
  type RuntimeProductionContextStateForReference,
} from '@worker/runtime/context/runtime-production-context-reference';
import {
  cardSetFor,
  cardSetForDisplayContext,
  hasDisplayContext,
  stagedCardSetFor,
  RuntimeProductionContextLimitError,
} from '@worker/runtime/context/runtime-production-display-context';

import {
  userHistoryFor,
  responseHistory,
  projectConversationHistory,
  type RetainedHistoryEntry,
} from '@worker/runtime/context/runtime-conversation-history';

type CardSetSource = NonNullable<ModelContextSource['cardSet']>;

export type RuntimeProductionModelContext = Pick<
  ModelContextSource,
  | 'userText'
  | 'history'
  | 'cardSet'
  | 'evidence'
  | 'savedReferences'
  | 'fieldPolicy'
  | 'conversationMemory'
>;

type ProductionContextState = {
  readonly history: readonly RetainedHistoryEntry[];
  readonly cardSet: CardSetSource | null;
  readonly cardSetReferenceOnly: boolean;
  readonly evidence: readonly ModelEvidenceSource[];
  readonly savedPlaceRefs: readonly string[];
  readonly excludedCandidateIds: readonly string[];
  readonly candidateIdentities: readonly RuntimeProductionCandidateIdentityReference[];
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
  };
  commitTurn(input: ThreadTurnRequest, response: unknown): void;
  snapshot(): {
    readonly history: readonly ModelHistoryEntry[];
    readonly cardSet: CardSetSource | null;
    readonly evidence: readonly ModelEvidenceSource[];
    readonly savedPlaceRefs: readonly string[];
    readonly candidateIdentities: readonly RuntimeProductionCandidateIdentityReference[];
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
    cardSetId: input.cardSetId,
    promotedCandidateId: input.promotedCandidateId,
    selectedCandidateId: input.selectedCandidateId,
    candidateOrder: input.candidateOrder,
    savedPlaceRefs: input.savedPlaceRefs,
    excludeCandidateIds: input.excludeCandidateIds,
    mode: input.mode,
    idempotencyKey: input.idempotencyKey,
  });

const appendBounded = <T>(items: readonly T[], next: readonly T[], max: number): readonly T[] =>
  [...items, ...next].slice(-max);

const unique = (items: readonly string[]): readonly string[] => [...new Set(items)];

const nextExcludedCandidateIds = (
  current: readonly string[],
  requested: readonly string[],
): readonly string[] => {
  const next = unique([...current, ...requested]);
  if (next.length > 50) throw new RuntimeProductionContextLimitError();
  return next;
};

const copyCardSet = (cardSet: CardSetSource | null): CardSetSource | null =>
  cardSet === null ? null : structuredClone(cardSet);

const copyState = (state: ProductionContextState): ProductionContextState => ({
  history: structuredClone(state.history),
  cardSet: copyCardSet(state.cardSet),
  cardSetReferenceOnly: state.cardSetReferenceOnly,
  evidence: structuredClone(state.evidence),
  savedPlaceRefs: [...state.savedPlaceRefs],
  excludedCandidateIds: [...state.excludedCandidateIds],
  candidateIdentities: structuredClone(state.candidateIdentities),
});

const candidateIdentitiesFor = (
  registry: CandidateObservationRegistryPort,
  scope: RegistryScope,
  cardSet: CardSetSource | null,
): readonly RuntimeProductionCandidateIdentityReference[] => {
  if (cardSet === null) return [];
  return cardSet.record.entries.flatMap((entry) => {
    const candidate = registry.readCandidate(scope, entry.candidateId);
    if (candidate === undefined) return [];
    if (candidate.ownerScopeRef !== scope.ownerScopeRef || candidate.threadId !== scope.threadId) {
      return [];
    }
    return [
      {
        candidateId: candidate.candidateId,
        provider: candidate.provider,
        recordRef: candidate.recordRef,
      },
    ];
  });
};

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

export const createRuntimeProductionContextStore = (input: {
  readonly registry: CandidateObservationRegistryPort;
  readonly persistence?: RuntimeProductionContextPersistence;
  readonly sessionExpiresAt?: () => string | undefined;
  readonly now?: () => string;
}): RuntimeProductionContextStore => {
  const scopeFor = (scope: RegistryScope): RegistryScope => ({ ...scope });
  let state: ProductionContextState = {
    history: [],
    cardSet: null,
    cardSetReferenceOnly: false,
    evidence: [],
    savedPlaceRefs: [],
    excludedCandidateIds: [],
    candidateIdentities: [],
  };
  let pending: PendingTurn | undefined;
  let boundScope: RegistryScope | undefined;
  let restored = false;

  const restoreForScope = (scope: RegistryScope): void => {
    if (restored) return;
    restored = true;
    const snapshot = input.persistence?.load(scope);
    if (snapshot === undefined) return;
    const now = Date.parse(input.now?.() ?? new Date().toISOString());
    if (
      snapshot.ownerScopeRef !== scope.ownerScopeRef ||
      snapshot.threadId !== scope.threadId ||
      !Number.isFinite(now) ||
      now >= Date.parse(snapshot.sessionExpiresAt)
    ) {
      return;
    }
    state = stateFromReference(snapshot, new Date(now).toISOString());
    persistState(scope);
  };

  const persistState = (scope: RegistryScope): void => {
    const sessionExpiresAt = input.sessionExpiresAt?.();
    if (input.persistence === undefined || sessionExpiresAt === undefined) return;
    const referenceState: RuntimeProductionContextStateForReference = state;
    input.persistence.save(
      referenceSnapshotFor({
        now: input.now?.() ?? new Date().toISOString(),
        scope,
        sessionExpiresAt,
        state: referenceState,
      }),
    );
  };

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
    restoreForScope(safeScope);
    const history = projectConversationHistory(
      state.history,
      input.now?.() ?? new Date().toISOString(),
    );
    // Reject an over-bound exclusion history before any model/provider work is started.
    nextExcludedCandidateIds(state.excludedCandidateIds, request.excludeCandidateIds);
    const explicitDisplayContext = hasDisplayContext(request);
    const stagedCardSet = cardSetForDisplayContext({
      registry: input.registry,
      scope: safeScope,
      previous: copyCardSet(state.cardSet),
      request,
      referenceOnly: state.cardSetReferenceOnly,
      knownExcludedCandidateIds: state.excludedCandidateIds,
      legacyStage: () =>
        stagedCardSetFor(
          input.registry,
          safeScope,
          copyCardSet(state.cardSet),
          request.excludeCandidateIds,
          state.cardSetReferenceOnly,
        ),
    });
    const cardSet =
      stagedCardSet ??
      (explicitDisplayContext || !state.cardSetReferenceOnly ? null : copyCardSet(state.cardSet));
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
        history,
        cardSet,
        evidence: [...structuredClone(state.evidence)],
        savedReferences: request.savedPlaceRefs.map((savedPlaceRef) => ({ savedPlaceRef })),
        fieldPolicy,
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

    // Check the durable reference bound before projecting candidates or mutating the registry.
    const nextExcluded = nextExcludedCandidateIds(
      active.base.excludedCandidateIds,
      active.input.excludeCandidateIds,
    );

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
            active.base.cardSetReferenceOnly && responseCardSet === active.cardSet,
          )
        : responseCardSet;
    if (parsed.output.kind === 'cards' && nextCardSet === null) return;
    const userHistory = userHistoryFor(active.input, active.scope);
    if (userHistory === undefined) return;
    const assistantHistory = responseHistory(parsed.output);
    const evidence = responseEvidenceIds(parsed.output)
      .map((observationId) => evidenceSourceFor(input.registry, active.scope, observationId))
      .filter((source): source is ModelEvidenceSource => source !== undefined);
    const candidateIdentities =
      parsed.output.kind === 'cards'
        ? candidateIdentitiesFor(input.registry, active.scope, nextCardSet)
        : active.base.candidateIdentities;
    const byEvidenceId = new Map(
      active.base.evidence.map((source) => [source.observationId, source]),
    );
    for (const source of evidence) byEvidenceId.set(source.observationId, source);
    const referenceCandidateIds = new Set(
      active.base.cardSetReferenceOnly
        ? (active.cardSet?.record.entries.map((entry) => entry.candidateId) ?? [])
        : [],
    );
    const knownExcludedCandidateIds = new Set(active.base.excludedCandidateIds);
    for (const candidateId of active.input.excludeCandidateIds) {
      const candidate = input.registry.readCandidate(active.scope, candidateId);
      if (
        candidate === undefined &&
        !referenceCandidateIds.has(candidateId) &&
        !knownExcludedCandidateIds.has(candidateId)
      )
        return;
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
      history: appendBounded(
        active.base.history,
        [{ ...userHistory, retention: parsed.output.message[0]?.retention }, ...assistantHistory],
        32,
      ),
      cardSet: nextCardSet,
      cardSetReferenceOnly:
        parsed.output.kind === 'cards' ? false : active.base.cardSetReferenceOnly,
      evidence: [...byEvidenceId.values()].slice(-64),
      savedPlaceRefs: [...active.input.savedPlaceRefs],
      excludedCandidateIds: nextExcluded,
      candidateIdentities,
    };
    pending = undefined;
    persistState(active.scope);
  };

  return {
    beginTurn,
    commitTurn,
    snapshot: () => ({
      history: structuredClone(state.history),
      cardSet: copyCardSet(state.cardSet),
      evidence: structuredClone(state.evidence),
      savedPlaceRefs: [...state.savedPlaceRefs],
      candidateIdentities: structuredClone(state.candidateIdentities),
    }),
  };
};
