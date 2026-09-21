import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SqlConversationRecords } from '@worker/adapters/out/persistence/conversations/sql-conversation-records';
import { SqlConversationRuns } from '@worker/adapters/out/persistence/conversations/sql-conversation-runs';
import type { ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
import type { ConversationMessageInput } from '@worker/domain/conversations/conversation-message';

const hasThreads = (
  value: unknown,
): value is Cloudflare.Env & { THREADS: DurableObjectNamespace<ThreadDO> } =>
  typeof value === 'object' && value !== null && 'THREADS' in value;

const now = '2026-09-21T10:00:00Z';
const scope = { ownerScopeRef: 'owner-a', conversationId: 'conversation-a' };
const accepted = {
  ...scope,
  runId: 'run-a',
  messageId: 'message-a',
  text: '静かなカフェが好き',
  now,
  expectedRevision: 1,
  idempotencyKey: 'send-a',
  inputFingerprint: 'a'.repeat(64),
};
const answer: ConversationMessageInput = {
  messageId: 'answer-a',
  role: 'assistant',
  source: { threadId: 'thread-a', turnId: 'turn-a', responseId: 'response-a' },
  parts: [{ kind: 'unavailable', reason: 'policy_withheld' }],
};

describe('durable conversation records and runs', () => {
  it('survives adapter reconstruction and atomically accepts and completes a run', async () => {
    if (!hasThreads(env)) throw new Error('THREAD_BINDING_MISSING');
    await runInDurableObject(
      env.THREADS.getByName(`conversation-storage-${crypto.randomUUID()}`),
      (_instance, state) => {
        let records = new SqlConversationRecords(state.storage);
        let runs = new SqlConversationRuns(records);
        expect(records.create({ ...scope, now, idempotencyKey: 'create-a' }).ok).toBe(true);
        expect(runs.accept(accepted)).toMatchObject({
          ok: true,
          replayed: false,
          conversation: { revision: 2 },
        });
        records = new SqlConversationRecords(state.storage);
        runs = new SqlConversationRuns(records);
        expect(runs.accept(accepted)).toMatchObject({ ok: true, replayed: true });
        expect(runs.accept({ ...accepted, inputFingerprint: 'b'.repeat(64) })).toMatchObject({
          ok: false,
          code: 'IDEMPOTENCY_CONFLICT',
        });
        expect(
          runs.accept({
            ...accepted,
            runId: 'run-b',
            messageId: 'message-b',
            idempotencyKey: 'send-b',
            expectedRevision: 2,
          }),
        ).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
        expect(records.messages({ ...scope, now, limit: 20, beforeSequence: null })).toMatchObject({
          ok: true,
          messages: [{ sequence: 1 }],
        });
        expect(
          runs.start({ ...scope, runId: 'run-a', now, threadId: 'thread-a', turnId: 'turn-a' }).ok,
        ).toBe(true);
        expect(
          runs.complete({
            ...scope,
            runId: 'run-a',
            now,
            message: answer,
            inputFingerprint: 'c'.repeat(64),
          }),
        ).toMatchObject({
          ok: true,
          run: { status: 'completed' },
          conversation: { revision: 3 },
        });
        expect(
          runs.complete({
            ...scope,
            runId: 'run-a',
            now,
            message: answer,
            inputFingerprint: 'c'.repeat(64),
          }),
        ).toMatchObject({
          ok: true,
          replayed: true,
        });
        expect(records.messages({ ...scope, now, limit: 1, beforeSequence: null })).toMatchObject({
          ok: true,
          nextBeforeSequence: 2,
          messages: [{ sequence: 2 }],
        });
        expect(records.messages({ ...scope, now, limit: 1, beforeSequence: 2 })).toMatchObject({
          ok: true,
          nextBeforeSequence: null,
          messages: [{ sequence: 1 }],
        });
        expect(records.read({ ...scope, ownerScopeRef: 'owner-b' })).toEqual({
          ok: false,
          code: 'NOT_FOUND',
        });
        expect(records.remove(scope)).toEqual({ ok: true, deleted: true });
        expect(records.remove(scope)).toEqual({ ok: true, deleted: false });
        expect(
          runs.complete({
            ...scope,
            runId: 'run-a',
            now,
            message: answer,
            inputFingerprint: 'c'.repeat(64),
          }).ok,
        ).toBe(false);
        expect(records.create({ ...scope, now, idempotencyKey: 'create-a' })).toEqual({
          ok: false,
          code: 'NOT_FOUND',
        });
        expect(
          records.list({ ownerScopeRef: scope.ownerScopeRef, limit: 20, before: null }),
        ).toMatchObject({ ok: true, conversations: [] });
      },
    );
  });
  it('rejects invalid acceptance without appending a user message', async () => {
    if (!hasThreads(env)) throw new Error('THREAD_BINDING_MISSING');
    await runInDurableObject(
      env.THREADS.getByName(`conversation-invalid-${crypto.randomUUID()}`),
      (_instance, state) => {
        const records = new SqlConversationRecords(state.storage);
        const runs = new SqlConversationRuns(records);
        records.create({ ...scope, now, idempotencyKey: 'create' });
        expect(runs.accept({ ...accepted, text: ' ' }).ok).toBe(false);
        expect(records.read(scope)).toMatchObject({
          ok: true,
          conversation: { revision: 1, lastSequence: 0 },
        });
        expect(runs.activeRun(scope)).toBeNull();
      },
    );
  });
});
