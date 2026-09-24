import { describe, expect, it } from 'vitest';
import type { AssistantResponse, ThreadTurnRequest } from '@ima/contracts';
import { denyModelContextFieldPolicy } from '@worker/application/model-context/model-context-policy';
import { createRuntimeProductionContextStore } from '@worker/runtime/context/runtime-production-context';
import type { RuntimeProductionContextReference } from '@worker/runtime/context/runtime-production-context-reference';
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
    areaText: null,
    budget: 'normal',
  },
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
    /** Replaces the persisted payload, e.g. with a snapshot written by an older Worker. */
    withSnapshot: (value: unknown) => {
      snapshot = value as RuntimeProductionContextReference;
      return reopen();
    },
    payload: () => JSON.stringify(snapshot),
    setNow: (value: string) => {
      now = value;
    },
  };
};

const policy = { ...denyModelContextFieldPolicy, history: 'allow' as const };

describe('conversation context', () => {
  it('restores a snapshot written with legacy quoted turns and saved refs without keeping them', () => {
    const f = fixture();
    const first = request('turn-question', '甘いものを食べたい');
    const store = f.reopen();
    store.beginTurn(first, SCOPE, policy);
    store.commitTurn(first, response(first, 'どのエリアで探しますか？'));
    const written = JSON.parse(f.payload()) as Record<string, unknown>;
    expect(written).not.toHaveProperty('originalTurns');
    expect(written).not.toHaveProperty('savedPlaceRefs');

    const legacy = f.withSnapshot({
      ...written,
      originalTurns: [{ threadId: SCOPE.threadId, turnId: 'turn-question' }],
      savedPlaceRefs: ['saved-legacy'],
    });
    const next = legacy.beginTurn(request('turn-answer', '恵比寿', 2), SCOPE, policy);
    expect(next.modelContext.history.map((entry) => entry.text)).toEqual([
      first.text,
      'どのエリアで探しますか？',
    ]);
    expect(legacy.snapshot()).not.toHaveProperty('originalTurns');
    expect(JSON.stringify(next.modelContext)).not.toContain('saved-legacy');
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
    // Each quoted body passes its own retention on to the text generated from it.
    expect(next.historyRetention).toEqual([allowRetention.retention, allowRetention.retention]);
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
