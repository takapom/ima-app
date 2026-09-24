import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AssistantResponse } from '@ima/contracts';
import type { CommitRequest } from '@worker/application/ports/commit';
import { createDurableCommitPort } from '@worker/adapters/out/persistence/thread/durable-commit-adapter';
import { ThreadConversationOutbox } from '@worker/adapters/out/persistence/conversations/thread-conversation-outbox';
import type { ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';

const hasThreads = (
  value: unknown,
): value is Cloudflare.Env & {
  THREADS: DurableObjectNamespace<ThreadDO>;
} => typeof value === 'object' && value !== null && 'THREADS' in value;

const now = '2026-09-22T10:00:00Z';
const later = '2026-09-22T11:00:00Z';
const setup = async () => {
  if (!hasThreads(env)) throw new Error('THREADS_MISSING');
  const target = {
    ownerScopeRef: 'owner',
    threadId: crypto.randomUUID(),
    turnId: 'turn',
    revision: 1,
  };
  const scope = {
    ownerScopeRef: target.ownerScopeRef,
    conversationId: 'conversation',
    runId: 'run',
  };
  const stub = env.THREADS.getByName(target.threadId);
  expect(await stub.initialize(target.ownerScopeRef, target.threadId)).toMatchObject({ ok: true });
  await runInDurableObject(stub, (_instance, state) => {
    new ThreadConversationOutbox(state.storage).bind({ ...scope, target });
    state.storage.sql.exec(
      'INSERT INTO runtime_turn (turn_id, owner_scope_ref, thread_id, revision, idempotency_key, input_digest, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      target.turnId,
      target.ownerScopeRef,
      target.threadId,
      target.revision,
      'send',
      'digest',
      'running',
    );
  });
  const request: CommitRequest = {
    expectedRevision: 1,
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
  };
  const response: AssistantResponse = {
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
        text: '保存する回答',
        retention: {
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
        },
      },
    ],
  };
  return { stub, scope, target, request, response };
};

describe('conversation delivery at the production commit boundary', () => {
  it('clears empty deliveries after failure or session expiry but preserves an active turn', async () => {
    const { stub } = await setup();
    await runInDurableObject(stub, async (_instance, state) => {
      const outbox = new ThreadConversationOutbox(state.storage);
      await outbox.purge(now);
      expect(state.storage.sql.exec('SELECT * FROM conversation_delivery').toArray()).toHaveLength(
        1,
      );
      state.storage.sql.exec("UPDATE runtime_turn SET status = 'failed'");
      await outbox.purge(now);
      expect(state.storage.sql.exec('SELECT * FROM conversation_delivery').toArray()).toEqual([]);
      state.storage.sql.exec(
        "INSERT INTO conversation_delivery VALUES ('expired', 'owner', 'conversation', 'thread', 'turn', 1, NULL, NULL)",
      );
      await outbox.purge(later, true);
      expect(state.storage.sql.exec('SELECT * FROM conversation_delivery').toArray()).toEqual([]);
    });
  });
  it('restores the answer immediately after commit without the later runtime result callback', async () => {
    const { stub, scope, request, response } = await setup();
    await runInDurableObject(stub, async (_instance, state) => {
      const outbox = new ThreadConversationOutbox(state.storage);
      const port = createDurableCommitPort(state.storage, { outbox, now: () => now });
      port.setConversationResponse(request.record, response);
      expect(port.commit(request)).toMatchObject({ status: 'committed' });
      // Simulate losing all process-local state before persistRuntimeResult can run.
      const recovered = await new ThreadConversationOutbox(state.storage).read(scope, now);
      expect(recovered?.message.parts).toEqual([
        expect.objectContaining({ kind: 'retained_text', text: '保存する回答' }),
      ]);
      expect(recovered?.response).toBeUndefined();
      expect(port.commit(request)).toMatchObject({
        status: 'committed',
        receipt: { replayed: true },
      });
      expect(state.storage.sql.exec('SELECT * FROM runtime_commit').toArray()).toHaveLength(1);
      expect(await outbox.read({ ...scope, ownerScopeRef: 'foreign' }, now)).toBeNull();
    });
  });

  it('rolls back the reference ledger, revision and runtime completion when delivery cannot be written', async () => {
    const { stub, scope, request, response } = await setup();
    await runInDurableObject(stub, async (_instance, state) => {
      const outbox = new ThreadConversationOutbox(state.storage);
      const port = createDurableCommitPort(state.storage, { outbox, now: () => now });
      state.storage.sql.exec(
        "CREATE TRIGGER reject_delivery BEFORE UPDATE OF message ON conversation_delivery BEGIN SELECT RAISE(ABORT, 'DELIVERY_WRITE_FAILED'); END",
      );
      port.setConversationResponse(request.record, response);
      expect(() => port.commit(request)).toThrow('DELIVERY_WRITE_FAILED');
      expect(state.storage.sql.exec('SELECT revision FROM thread_state').one()).toEqual({
        revision: 1,
      });
      expect(state.storage.sql.exec('SELECT status FROM runtime_turn').one()).toEqual({
        status: 'running',
      });
      expect(state.storage.sql.exec('SELECT * FROM runtime_commit').toArray()).toEqual([]);
      expect(await outbox.read(scope, now)).toBeNull();
      state.storage.sql.exec('DROP TRIGGER reject_delivery');
      // A failed attempt must not leave a pending payload usable by a later commit.
      expect(() => port.commit(request)).toThrow('CONVERSATION_COMMIT_RESPONSE_MISSING');
      port.setConversationResponse(request.record, response);
      expect(port.commit(request)).toMatchObject({ status: 'committed' });
    });
  });

  it('never persists withheld text and cannot deliver a cancelled turn', async () => {
    const { stub, scope, request, response } = await setup();
    await runInDurableObject(stub, async (_instance, state) => {
      const outbox = new ThreadConversationOutbox(state.storage);
      const port = createDurableCommitPort(state.storage, { outbox, now: () => now });
      const withheld: AssistantResponse = {
        ...response,
        message: response.message.map((part) => ({
          ...part,
          retention: {
            ...part.retention,
            retentionDecision: 'deny',
            retentionUntil: null,
            deletionScheduledAt: null,
            restoreMode: 'reference_only',
            policyStatus: 'policy_withheld',
          },
        })),
      };
      state.storage.sql.exec("UPDATE runtime_turn SET status = 'cancel_requested'");
      port.setConversationResponse(request.record, withheld);
      expect(port.commit(request)).toMatchObject({ status: 'conflict' });
      expect(await outbox.read(scope, now)).toBeNull();
      state.storage.sql.exec("UPDATE runtime_turn SET status = 'running'");
      port.setConversationResponse(request.record, withheld);
      expect(port.commit(request)).toMatchObject({ status: 'committed' });
      const restored = await new ThreadConversationOutbox(state.storage).read(scope, now);
      expect(restored?.message.parts).toEqual([{ kind: 'unavailable', reason: 'policy_withheld' }]);
      expect(
        JSON.stringify(state.storage.sql.exec('SELECT * FROM conversation_delivery').toArray()),
      ).not.toContain('保存する回答');
    });
  });
});
