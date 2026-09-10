import type { AssistantResponse, ThreadTurnRequest } from '@ima/contracts';
import {
  CandidateObservationRegistry,
  denyModelContextFieldPolicy,
  type RegistryIdPort,
  type RegistryScope,
} from '@ima/core';
import { describe, expect, it } from 'vitest';
import { createRuntimeProductionContextStore } from '../../src/runtime/runtime-production-context';
import type { RuntimeProductionContextReference } from '../../src/runtime/runtime-production-context-reference';
import {
  RuntimeProductionContextLimitError,
  RuntimeProductionDisplayContextError,
} from '../../src/runtime/runtime-production-display-context';
import { runtimeResultForError } from '../../src/thread-runtime/controller-errors';

const scope: RegistryScope = { ownerScopeRef: 'context-owner', threadId: 'context-thread' };

class TestIds implements RegistryIdPort {
  private next = 0;

  private id(prefix: string): string {
    this.next += 1;
    return `${prefix}-${this.next}`;
  }

  nextCallId(): string {
    return this.id('call');
  }

  nextPlaceRef(): string {
    return this.id('place');
  }

  nextCandidateId(): string {
    return this.id('candidate');
  }

  nextObservationId(): string {
    return this.id('observation');
  }

  nextResponseId(): string {
    return this.id('response');
  }
}

const requestFor = (turnId: string, revision: number, text: string): ThreadTurnRequest => ({
  schemaVersion: 'v1',
  requestId: `request-${turnId}`,
  turnId,
  revision,
  text,
  clientNow: '2026-09-10T12:00:00.000Z',
  location: {
    status: 'unavailable',
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: null,
    budget: 'normal',
  },
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: `idempotency-${turnId}`,
});

const messageFor = (request: ThreadTurnRequest): AssistantResponse => ({
  schemaVersion: 'v1',
  threadId: scope.threadId,
  turnId: request.turnId ?? request.requestId,
  responseId: `response-${request.turnId ?? request.requestId}`,
  revision: request.revision + 1,
  kind: 'message',
  presentation: 'keep',
  cardSetId: null,
  message: [
    {
      text: '確認しました。',
      evidenceIds: [],
      evidence: [],
      basis: 'conversational',
      retention: {
        retentionDecision: 'deny',
        retentionMode: 'session_only',
        sessionExpiresAt: '2026-09-10T23:00:00.000Z',
        freshUntil: null,
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
        attribution: null,
        restoreMode: 'reference_only',
        policyStatus: 'policy_withheld',
        displayPolicyStatus: 'policy_withheld',
      },
    },
  ],
});

const storeForTest = () =>
  createRuntimeProductionContextStore({
    registry: new CandidateObservationRegistry(
      { now: () => '2026-09-10T12:00:00.000Z' },
      new TestIds(),
    ),
  });

const referenceFor = (
  cardSetScope: RegistryScope = scope,
  excludedCandidateIds: readonly string[] = [],
) => ({
  ownerScopeRef: scope.ownerScopeRef,
  threadId: scope.threadId,
  sessionExpiresAt: '2026-09-10T23:00:00.000Z',
  savedPlaceRefs: [],
  history: [],
  originalTurns: [],
  cardSet: {
    cardSetId: 'card-set-1',
    scope: cardSetScope,
    responseId: 'response-card-set-1',
    entries: [
      { candidateId: 'candidate-1', displayOrder: 0, role: 'hero' as const },
      { candidateId: 'candidate-2', displayOrder: 1, role: 'alt' as const },
      { candidateId: 'candidate-3', displayOrder: 2, role: 'alt' as const },
    ],
    selectedCandidateId: null,
    excludedCandidateIds: [],
  },
  excludedCandidateIds: [...excludedCandidateIds],
  evidence: [],
});

const storeForReference = (
  cardSetScope?: RegistryScope,
  excludedCandidateIds: readonly string[] = [],
) =>
  createRuntimeProductionContextStore({
    registry: new CandidateObservationRegistry(
      { now: () => '2026-09-10T12:00:00.000Z' },
      new TestIds(),
    ),
    persistence: {
      load: () => referenceFor(cardSetScope, excludedCandidateIds),
      save: () => undefined,
      clear: () => undefined,
    },
    now: () => '2026-09-10T12:00:00.000Z',
  });

describe('runtime production context store', () => {
  it('requires the full request identity before advancing context', () => {
    const store = storeForTest();
    const first = requestFor('context-turn-1', 1, '最初の条件');
    store.beginTurn(first, scope, denyModelContextFieldPolicy);

    store.commitTurn({ ...first, text: '遅れて届いた別の原文' }, messageFor(first));
    expect(store.snapshot().history).toHaveLength(0);

    store.commitTurn(first, { ...messageFor(first), turnId: 'wrong-turn' });
    expect(store.snapshot().history).toHaveLength(0);

    store.commitTurn(first, { ...messageFor(first), revision: first.revision + 2 });
    expect(store.snapshot().history).toHaveLength(0);

    store.commitTurn(first, messageFor(first));
    expect(store.snapshot().history).toHaveLength(2);
  });

  it('keeps canceled and superseded turns out of the next context', () => {
    const store = storeForTest();
    const canceled = requestFor('context-canceled', 1, '失敗した検索原文');
    store.beginTurn(canceled, scope, denyModelContextFieldPolicy);

    // A canceled runtime turn is intentionally modeled as a non-response value: only a
    // schema-valid AssistantResponse can advance history or originalTurns.
    store.commitTurn(canceled, { status: 'cancelled' });
    expect(store.snapshot().history).toHaveLength(0);
    expect(store.snapshot().originalTurns).toHaveLength(0);

    const superseded = requestFor('context-superseded', 2, '置き換えられた原文');
    const next = requestFor('context-next', 3, '次の有効な条件');
    store.beginTurn(superseded, scope, denyModelContextFieldPolicy);
    store.beginTurn(next, scope, denyModelContextFieldPolicy);

    // The old callback must not consume the pending next turn.
    store.commitTurn(superseded, messageFor(superseded));
    expect(store.snapshot().history).toHaveLength(0);
    store.commitTurn(next, messageFor(next));

    const snapshot = store.snapshot();
    expect(snapshot.history.map((entry) => entry.text)).toEqual([
      '次の有効な条件',
      '確認しました。',
    ]);
    expect(snapshot.originalTurns).toEqual([
      { threadId: scope.threadId, turnId: next.turnId, text: next.text },
    ]);
  });

  it('copies projected state and rejects a different scope on the same connection', () => {
    const store = storeForTest();
    const first = requestFor('context-turn-1', 1, '最初の条件');
    const projected = store.beginTurn(first, scope, denyModelContextFieldPolicy);
    projected.modelContext.history.push({
      threadId: scope.threadId,
      turnId: 'caller-mutation',
      role: 'user',
      text: 'caller mutation',
      evidenceIds: [],
      basis: 'conversational',
    });
    store.commitTurn(first, messageFor(first));

    const second = requestFor('context-turn-2', 2, '次の条件');
    const next = store.beginTurn(second, scope, denyModelContextFieldPolicy);
    expect(next.modelContext.history).toHaveLength(2);
    store.commitTurn(second, { status: 'cancelled' });
    const afterCancelled = store.beginTurn(
      requestFor('context-turn-3', 3, '取消後の条件'),
      scope,
      denyModelContextFieldPolicy,
    );
    expect(afterCancelled.modelContext.history).toHaveLength(2);
    expect(() =>
      store.beginTurn(
        second,
        { ownerScopeRef: 'other-owner', threadId: scope.threadId },
        denyModelContextFieldPolicy,
      ),
    ).toThrow('RUNTIME_CONTEXT_SCOPE_MISMATCH');
  });

  it('passes the displayed card set, order, selection, and exclusion to model context', () => {
    const store = storeForReference();
    const request = {
      ...requestFor('context-display', 2, '2つ目について教えて'),
      cardSetId: 'card-set-1',
      promotedCandidateId: 'candidate-2',
      selectedCandidateId: 'candidate-2',
      candidateOrder: ['candidate-2', 'candidate-1'],
      savedPlaceRefs: ['saved-1'],
      excludeCandidateIds: ['candidate-3'],
    };
    const projected = store.beginTurn(request, scope, denyModelContextFieldPolicy);
    expect(projected.modelContext.cardSet?.record).toMatchObject({
      cardSetId: 'card-set-1',
      selectedCandidateId: 'candidate-2',
      excludedCandidateIds: ['candidate-3'],
      entries: [
        { candidateId: 'candidate-2', displayOrder: 0, role: 'hero' },
        { candidateId: 'candidate-1', displayOrder: 1, role: 'alt' },
        { candidateId: 'candidate-3', displayOrder: 2, role: 'alt' },
      ],
    });
    expect(projected.modelContext.savedReferences).toEqual([{ savedPlaceRef: 'saved-1' }]);
  });

  it('rejects stale, foreign, duplicated, and excluded display references', () => {
    expect(() =>
      storeForReference().beginTurn(
        {
          ...requestFor('context-stale-card-set', 2, '古い候補を参照'),
          cardSetId: 'card-set-old',
          promotedCandidateId: null,
          candidateOrder: [],
          selectedCandidateId: null,
        },
        scope,
        denyModelContextFieldPolicy,
      ),
    ).toThrow('RUNTIME_CONTEXT_CARD_SET_STALE_CARD_SET');

    expect(() =>
      storeForReference({ ownerScopeRef: 'other-owner', threadId: scope.threadId }).beginTurn(
        {
          ...requestFor('context-foreign-card-set', 2, '別owner候補を参照'),
          cardSetId: 'card-set-1',
          promotedCandidateId: null,
          candidateOrder: ['candidate-1', 'candidate-2', 'candidate-3'],
          selectedCandidateId: null,
        },
        scope,
        denyModelContextFieldPolicy,
      ),
    ).toThrow('RUNTIME_CONTEXT_CARD_SET_SCOPE_MISMATCH');

    expect(() =>
      storeForReference().beginTurn(
        {
          ...requestFor('context-duplicate-order', 2, '重複順序'),
          cardSetId: 'card-set-1',
          promotedCandidateId: null,
          candidateOrder: ['candidate-1', 'candidate-1'],
          selectedCandidateId: null,
        },
        scope,
        denyModelContextFieldPolicy,
      ),
    ).toThrow('RUNTIME_CONTEXT_CARD_SET_INVALID_ORDER');

    expect(() =>
      storeForReference().beginTurn(
        {
          ...requestFor('context-excluded-selection', 2, '除外候補を選択'),
          cardSetId: 'card-set-1',
          promotedCandidateId: null,
          candidateOrder: ['candidate-1', 'candidate-2'],
          selectedCandidateId: 'candidate-3',
          excludeCandidateIds: ['candidate-3'],
        },
        scope,
        denyModelContextFieldPolicy,
      ),
    ).toThrow('RUNTIME_CONTEXT_CARD_SET_SELECTION_EXCLUDED');

    expect(() =>
      storeForReference().beginTurn(
        {
          ...requestFor('context-excluded-promotion', 2, '除外候補を主提案にする'),
          cardSetId: 'card-set-1',
          promotedCandidateId: 'candidate-3',
          selectedCandidateId: null,
          candidateOrder: ['candidate-1', 'candidate-2'],
          excludeCandidateIds: ['candidate-3'],
        },
        scope,
        denyModelContextFieldPolicy,
      ),
    ).toThrow('RUNTIME_CONTEXT_CARD_SET_PROMOTION_EXCLUDED');

    expect(() =>
      storeForReference().beginTurn(
        {
          ...requestFor('context-null-card-set-exclusion', 2, '候補を除外したい'),
          cardSetId: null,
          promotedCandidateId: null,
          selectedCandidateId: null,
          candidateOrder: [],
          excludeCandidateIds: ['candidate-1'],
        },
        scope,
        denyModelContextFieldPolicy,
      ),
    ).toThrow('RUNTIME_CONTEXT_CARD_SET_EXCLUSION_WITHOUT_CARD_SET');
  });

  it('accepts an owner-thread-bound exclusion inherited across card-set replacement', () => {
    const store = storeForReference(undefined, ['candidate-old']);
    const projected = store.beginTurn(
      {
        ...requestFor('context-inherited-exclusion', 2, '前の候補は除外したまま'),
        cardSetId: 'card-set-1',
        promotedCandidateId: null,
        candidateOrder: ['candidate-1', 'candidate-2', 'candidate-3'],
        selectedCandidateId: null,
        excludeCandidateIds: ['candidate-old'],
      },
      scope,
      denyModelContextFieldPolicy,
    );
    expect(projected.modelContext.cardSet?.record.cardSetId).toBe('card-set-1');
    expect(projected.modelContext.cardSet?.record.excludedCandidateIds).toEqual([]);
  });

  it('maps display-context rejection to a public revision conflict result', () => {
    expect(
      runtimeResultForError(new RuntimeProductionDisplayContextError('STALE_CARD_SET')),
    ).toMatchObject({ status: 'failed', code: 'REVISION_CONFLICT', response: null });
    expect(runtimeResultForError(new RuntimeProductionContextLimitError())).toMatchObject({
      status: 'failed',
      code: 'INVALID_ARGUMENT',
      response: null,
    });
  });

  it('rejects a cross-turn exclusion union above the persisted reference bound', () => {
    const initialExclusions = Array.from({ length: 49 }, (_, index) => `excluded-${index}`);
    const persisted: RuntimeProductionContextReference[] = [];
    const store = createRuntimeProductionContextStore({
      registry: new CandidateObservationRegistry(
        { now: () => '2026-09-10T12:00:00.000Z' },
        new TestIds(),
      ),
      persistence: {
        load: () => referenceFor(undefined, initialExclusions),
        save: (snapshot) => persisted.push(snapshot),
        clear: () => undefined,
      },
      sessionExpiresAt: () => '2026-09-10T23:00:00.000Z',
      now: () => '2026-09-10T12:00:00.000Z',
    });
    const first = {
      ...requestFor('context-exclusion-50', 2, '50件目の除外'),
      excludeCandidateIds: ['candidate-1'],
    };
    store.beginTurn(first, scope, denyModelContextFieldPolicy);
    store.commitTurn(first, messageFor(first));
    expect(persisted.at(-1)?.excludedCandidateIds).toHaveLength(50);

    const overflow = {
      ...requestFor('context-exclusion-51', 3, '51件目の除外'),
      excludeCandidateIds: ['candidate-2'],
    };
    expect(() => store.beginTurn(overflow, scope, denyModelContextFieldPolicy)).toThrow(
      'RUNTIME_CONTEXT_EXCLUSION_LIMIT',
    );
    expect(persisted.at(-1)?.excludedCandidateIds).toHaveLength(50);
  });
});
