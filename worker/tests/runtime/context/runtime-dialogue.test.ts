import { describe, expect, it } from 'vitest';
import type { AssistantResponse, ThreadTurnRequest } from '@ima/contracts';
import { denyModelContextFieldPolicy, validateModelActionMetadata } from '@ima/core';
import { createRuntimeProductionContextStore } from '@worker/infrastructure/runtime/context/runtime-production-context';
import type { RuntimeProductionContextReference } from '@worker/infrastructure/runtime/context/runtime-production-context-reference';
import { createToolRegistry } from '../../adapters/inbound/tools/registry-fixture';
import {
  allowRetention,
  retention,
  NOW,
  SCOPE,
} from '../turn-execution/runtime-turn-composition-fixture';

const request = (turnId: string, text: string, revision = 1): ThreadTurnRequest => ({
  schemaVersion: 'v1',
  requestId: `request-${turnId}`,
  turnId,
  revision,
  text,
  clientNow: NOW,
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
  idempotencyKey: `key-${turnId}`,
});

const response = (input: ThreadTurnRequest, text: string, allow = true): AssistantResponse => ({
  schemaVersion: 'v1',
  threadId: SCOPE.threadId,
  turnId: input.turnId ?? input.requestId,
  responseId: `response-${input.requestId}`,
  revision: input.revision + 1,
  kind: 'message',
  presentation: 'keep',
  cardSetId: null,
  message: [
    {
      text,
      basis: 'conversational',
      evidence: [],
      evidenceIds: [],
      retention: allow ? allowRetention.retention : retention.retention,
    },
  ],
});

const fixture = () => {
  let snapshot: RuntimeProductionContextReference | undefined;
  let now = NOW;
  const reopen = () =>
    createRuntimeProductionContextStore({
      registry: createToolRegistry().registry,
      persistence: {
        load: () => snapshot,
        save: (value) => {
          snapshot = structuredClone(value);
        },
        clear: () => {
          snapshot = undefined;
        },
      },
      now: () => now,
      sessionExpiresAt: () => allowRetention.retention.sessionExpiresAt,
    });
  return {
    reopen,
    payload: () => JSON.stringify(snapshot),
    setNow: (value: string) => {
      now = value;
    },
  };
};

const policy = { ...denyModelContextFieldPolicy, history: 'allow' as const };

describe('conversation context', () => {
  it('validates a current utterance before committing it and still rejects a forged quote', () => {
    const store = fixture().reopen();
    const input = request('turn-current', '最低20分は滞在したい');
    const context = store.beginTurn(input, SCOPE, policy).constraintContext;
    const change = { minimumStayMinutes: 20, sourceTurnId: 'turn-current', quote: input.text };
    const metadata = { turnConstraints: { changes: [change] } };
    expect(validateModelActionMetadata(metadata, context)).toEqual(metadata);
    expect(() =>
      validateModelActionMetadata(
        { turnConstraints: { changes: [{ ...change, quote: '最低60分' }] } },
        context,
      ),
    ).toThrow('quote is not an exact source substring');
    expect(() =>
      validateModelActionMetadata(
        { turnConstraints: { changes: [{ ...change, sourceTurnId: 'another-thread-turn' }] } },
        context,
      ),
    ).toThrow('source turn is not in this thread');
    expect(store.snapshot().originalTurns).toEqual([]);
    const current = context.originalTurns[0];
    if (current === undefined) throw new Error('current turn missing');
    current.text = 'mutated projection';
    expect(store.beginTurn(input, SCOPE, policy).constraintContext.originalTurns[0]?.text).toBe(
      input.text,
    );
  });

  it('restores the question and previous answer so a short reply has meaning', () => {
    const f = fixture();
    const first = request('turn-question', '甘いものを食べたい');
    const store = f.reopen();
    store.beginTurn(first, SCOPE, policy);
    store.commitTurn(first, response(first, 'どのエリアで探しますか？'));
    const second = request('turn-answer', '恵比寿', 2);
    const restored = f.reopen();
    const next = restored.beginTurn(second, SCOPE, policy);
    expect(next.modelContext.history.map((entry) => entry.text)).toEqual([
      first.text,
      'どのエリアで探しますか？',
    ]);
    expect(next.modelContext.userText).toBe('恵比寿');
    restored.commitTurn(second, response(second, 'カフェを探します。'));
    expect(
      f
        .reopen()
        .beginTurn(request('third', 'もっと安く', 3), SCOPE, policy)
        .modelContext.history.map((entry) => entry.text),
    ).toEqual([first.text, 'どのエリアで探しますか？', '恵比寿', 'カフェを探します。']);
  });

  it('does not persist denied content or a failed turn', () => {
    const f = fixture();
    const store = f.reopen();
    const first = request('denied', 'DENIED_USER_TEXT');
    store.beginTurn(first, SCOPE, policy);
    store.commitTurn(first, response(first, 'DENIED_ASSISTANT_TEXT', false));
    expect(f.payload()).not.toContain('DENIED_USER_TEXT');
    expect(f.payload()).not.toContain('DENIED_ASSISTANT_TEXT');
    const failed = request('failed', 'FAILED_USER_TEXT', 2);
    store.beginTurn(failed, SCOPE, policy);
    store.commitTurn(failed, { status: 'failed' });
    expect(f.payload()).not.toContain('FAILED_USER_TEXT');
  });

  it('drops expired bodies on restore and keeps owner/thread scope isolated', () => {
    const f = fixture();
    const store = f.reopen();
    const first = request('expiry', 'EXPIRED_USER_TEXT');
    store.beginTurn(first, SCOPE, policy);
    store.commitTurn(first, response(first, 'EXPIRED_QUESTION'));
    expect(f.payload()).toContain('EXPIRED_QUESTION');
    f.setNow('2026-09-10T00:01:00Z');
    expect(
      f.reopen().beginTurn(request('after-freshness', 'はい'), SCOPE, policy).modelContext
        .history[1]?.text,
    ).toBe('EXPIRED_QUESTION');
    const foreign = f
      .reopen()
      .beginTurn(request('foreign', 'はい'), { ...SCOPE, ownerScopeRef: 'other' }, policy);
    expect(foreign.modelContext.history).toEqual([]);
    f.setNow('2026-09-10T00:02:00Z');
    expect(JSON.stringify(store.beginTurn(request('warm', 'はい'), SCOPE, policy))).not.toContain(
      'EXPIRED_',
    );
    const next = f.reopen().beginTurn(request('later', 'はい'), SCOPE, policy);
    expect(JSON.stringify(next)).not.toContain('EXPIRED_');
    expect(f.payload()).not.toContain('EXPIRED_');
  });
});
