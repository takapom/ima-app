import type { AssistantResponse, ThreadTurnRequest } from '@ima/contracts';
import {
  CandidateObservationRegistry,
  denyModelContextFieldPolicy,
  type RegistryIdPort,
  type RegistryScope,
} from '@ima/core';
import { describe, expect, it } from 'vitest';
import { createRuntimeProductionContextStore } from '../../src/runtime/runtime-production-context';

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
});
