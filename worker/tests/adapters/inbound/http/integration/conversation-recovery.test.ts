import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
import { SqlConversationRecords } from '@worker/adapters/out/persistence/conversations/sql-conversation-records';
import { SqlConversationRuns } from '@worker/adapters/out/persistence/conversations/sql-conversation-runs';
import { SqlConversationMemory } from '@worker/adapters/out/persistence/conversations/sql-conversation-memory';
import { ThreadConversationOutbox } from '@worker/adapters/out/persistence/conversations/thread-conversation-outbox';
import type { RetentionMetadata } from '@ima/contracts';

const hasThreads = (
  value: unknown,
): value is Cloudflare.Env & { THREADS: DurableObjectNamespace<ThreadDO> } =>
  typeof value === 'object' && value !== null && 'THREADS' in value;
const scope = { ownerScopeRef: 'memory-owner', conversationId: 'memory-conversation' };
const now = '2026-09-21T10:00:00Z';
const later = '2026-09-21T11:00:00Z';
const retention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'session_only',
  sessionExpiresAt: later,
  freshUntil: later,
  displayUntil: later,
  retentionUntil: later,
  deletionScheduledAt: later,
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};
const target = {
  ownerScopeRef: scope.ownerScopeRef,
  threadId: 'memory-thread',
  turnId: 'memory-turn',
  revision: 1,
};

describe('conversation recovery and bounded memory', () => {
  it('keeps delivery atomic, replays after expiry with the same fingerprint, and never completes twice', async () => {
    if (!hasThreads(env)) throw new Error('THREADS_MISSING');
    await runInDurableObject(
      env.THREADS.getByName(crypto.randomUUID()),
      async (_instance, state) => {
        const records = new SqlConversationRecords(state.storage);
        const runs = new SqlConversationRuns(records);
        const deliveryScope = { ...scope, runId: 'memory-run' };
        records.create({ ...scope, now, idempotencyKey: 'create' });
        runs.accept({
          ...deliveryScope,
          now,
          expectedRevision: 1,
          messageId: 'question',
          text: '静かな店',
          idempotencyKey: 'send',
          inputFingerprint: 'a'.repeat(64),
        });
        expect(
          runs.start({
            ...deliveryScope,
            now: '2020-01-01T00:00:00Z',
            threadId: target.threadId,
            turnId: target.turnId,
          }),
        ).toEqual({ ok: false, code: 'INVALID_INPUT' });
        runs.start({ ...deliveryScope, now, threadId: target.threadId, turnId: target.turnId });
        let outbox = new ThreadConversationOutbox(state.storage);
        outbox.bind({ ...deliveryScope, target });
        const complete = () =>
          outbox.commit(
            {
              expectedRevision: target.revision,
              record: {
                schemaVersion: 'v1',
                scope: { ownerScopeRef: target.ownerScopeRef, threadId: target.threadId },
                turnId: target.turnId,
                idempotencyKey: 'commit',
                responseId: 'answer',
                revision: 2,
                payloadDigest: 'digest',
                presentation: 'keep',
                references: { candidateIds: [], observationIds: [] },
              },
            },
            {
              schemaVersion: 'v1',
              threadId: target.threadId,
              turnId: target.turnId,
              responseId: 'answer',
              revision: 2,
              kind: 'message',
              presentation: 'keep',
              cardSetId: null,
              message: [
                {
                  text: '静かな店を探します',
                  retention,
                },
              ],
            },
            now,
          );
        expect(() =>
          state.storage.transactionSync(() => {
            complete();
            throw new Error('ROLLBACK');
          }),
        ).toThrow('ROLLBACK');
        expect(await outbox.read(deliveryScope, now)).toBeNull();
        state.storage.transactionSync(complete);
        outbox = new ThreadConversationOutbox(state.storage);
        const first = await outbox.read(deliveryScope, now);
        if (first === null) throw new Error('DELIVERY_MISSING');
        expect(runs.complete({ ...first, now }).ok).toBe(true);
        const expired = await outbox.read(deliveryScope, later);
        if (expired === null) throw new Error('DELIVERY_MISSING');
        expect(expired.inputFingerprint).toBe(first.inputFingerprint);
        expect(expired.message.parts).toEqual([{ kind: 'unavailable', reason: 'expired' }]);
        expect(runs.complete({ ...expired, now: later })).toMatchObject({
          ok: true,
          replayed: true,
        });
        expect(
          records.messages({ ...scope, now: later, limit: 20, beforeSequence: null }),
        ).toMatchObject({ ok: true, messages: [{ sequence: 1 }, { sequence: 2 }] });
        expect(
          await outbox.read({ ...deliveryScope, ownerScopeRef: 'other-owner' }, now),
        ).toBeNull();
        records.remove(scope);
        expect(runs.complete({ ...expired, now: later })).toEqual({ ok: false, code: 'NOT_FOUND' });
        outbox.acknowledge(deliveryScope);
        expect(await outbox.read(deliveryScope, now)).toBeNull();
      },
    );
  });
  it('bounds recent input and a source-linked user summary, excludes future/expired text, and deletes derived data', async () => {
    if (!hasThreads(env)) throw new Error('THREADS_MISSING');
    await runInDurableObject(env.THREADS.getByName(crypto.randomUUID()), (_instance, state) => {
      const records = new SqlConversationRecords(state.storage);
      records.create({ ...scope, now, idempotencyKey: 'create' });
      for (let i = 1; i <= 70; i++) {
        expect(
          records.append({
            ...scope,
            now,
            expectedRevision: i,
            idempotencyKey: `append-${i}`,
            inputFingerprint: i.toString(16).padStart(64, '0'),
            message: {
              messageId: `message-${i}`,
              role: 'user',
              source: null,
              parts: [{ kind: 'user_text', text: `${i}: ${'条件'.repeat(180)}` }],
            },
          }).ok,
        ).toBe(true);
      }
      records.append({
        ...scope,
        now,
        expectedRevision: 71,
        idempotencyKey: 'answer',
        inputFingerprint: 'c'.repeat(64),
        message: {
          messageId: 'provider-answer',
          role: 'assistant',
          source: { threadId: 'thread', turnId: 'turn', responseId: 'response' },
          parts: [{ kind: 'retained_text', text: '保存期限付きの店舗情報', retention }],
        },
      });
      const result = new SqlConversationMemory(records).loadMemory({
        ...scope,
        now: later,
        beforeSequence: 72,
      });
      if (!result.ok) throw new Error(result.code);
      expect(result.memory.entries.length).toBeGreaterThan(0);
      expect(result.memory.entries.length).toBeLessThan(32);
      expect(JSON.stringify(result.memory)).not.toContain('保存期限付き');
      expect(result.memory.summary?.excerpts[0]?.messageId).toBe('message-1');
      expect(result.memory.summary?.excerpts.length).toBeLessThanOrEqual(8);
      const through = result.memory.summary?.throughSequence ?? 0;
      expect(
        result.memory.entries.every((item) => item.sequence > through && item.sequence < 72),
      ).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(result.memory)).byteLength).toBeLessThan(
        13_000,
      );
      expect(
        new SqlConversationMemory(records).loadMemory({ ...scope, now, beforeSequence: 1 }),
      ).toMatchObject({ ok: true, memory: { entries: [], summary: null } });
      expect(
        new SqlConversationMemory(records).loadMemory({
          ...scope,
          ownerScopeRef: 'foreign',
          now,
          beforeSequence: 72,
        }),
      ).toEqual({ ok: false, code: 'NOT_FOUND' });
      records.remove(scope);
      expect(state.storage.sql.exec('SELECT * FROM conversation_summaries').toArray()).toEqual([]);
    });
  });
});
