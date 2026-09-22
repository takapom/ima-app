import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ConversationDeletions } from '@worker/adapters/out/persistence/conversations/conversation-deletions';
import { SqlConversationRecords } from '@worker/adapters/out/persistence/conversations/sql-conversation-records';
import { SqlConversationRuns } from '@worker/adapters/out/persistence/conversations/sql-conversation-runs';
import type { ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';

const hasThreads = (
  value: unknown,
): value is Cloudflare.Env & {
  THREADS: DurableObjectNamespace<ThreadDO>;
} => typeof value === 'object' && value !== null && 'THREADS' in value;

it('retries cleanup of a tombstoned Thread and only removes the queue after cleanup succeeds', async () => {
  if (!hasThreads(env)) throw new Error('THREADS_MISSING');
  const threads = env.THREADS;
  const ownerScopeRef = 'deletion-owner';
  const conversationId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const thread = threads.getByName(threadId);
  expect(await thread.initialize(ownerScopeRef, threadId)).toMatchObject({ ok: true });
  await runInDurableObject(thread, (instance, state) => {
    // Fault injection at the runtime cleanup boundary; the Thread deletion and queue are real.
    const internal = instance as unknown as {
      runtimeController: { cleanupForDelete: () => Promise<void> };
    };
    const cleanup = internal.runtimeController.cleanupForDelete.bind(internal.runtimeController);
    state.storage.sql.exec('CREATE TABLE cleanup_attempts (attempt INTEGER)');
    internal.runtimeController.cleanupForDelete = async () => {
      state.storage.sql.exec('INSERT INTO cleanup_attempts VALUES (1)');
      if (state.storage.sql.exec('SELECT * FROM cleanup_attempts').toArray().length === 1)
        throw new Error('INJECTED_CLEANUP_FAILURE');
      await cleanup();
    };
  });
  const history = threads.getByName(crypto.randomUUID());
  await runInDurableObject(history, async (_instance, state) => {
    const records = new SqlConversationRecords(state.storage);
    const runs = new SqlConversationRuns(records);
    const deletions = new ConversationDeletions(records, threads);
    const scopedThread = threads.getByName(threadId);
    const scope = { ownerScopeRef, conversationId };
    const now = '2026-09-22T10:00:00Z';
    records.create({ ...scope, now, idempotencyKey: 'create' });
    runs.accept({
      ...scope,
      now,
      expectedRevision: 1,
      runId: 'run',
      messageId: 'message',
      text: '削除する発言',
      idempotencyKey: 'send',
      inputFingerprint: 'a'.repeat(64),
    });
    runs.start({ ...scope, now, runId: 'run', threadId, turnId: 'turn' });
    expect(deletions.mark(scope)).toMatchObject({ ok: true });
    await deletions.flush();
    expect(state.storage.sql.exec('SELECT * FROM conversation_deletions').toArray()).toHaveLength(
      1,
    );
    expect(await scopedThread.read(ownerScopeRef)).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(
      await scopedThread.deleteThread(
        'foreign',
        null,
        null,
        `conversation-delete-${conversationId}`,
      ),
    ).toEqual({ ok: false, code: 'FORBIDDEN' });
    state.storage.sql.exec('UPDATE conversation_deletions SET retry_at = 0');
    await new ConversationDeletions(records, threads).flush();
    expect(state.storage.sql.exec('SELECT * FROM conversation_deletions').toArray()).toEqual([]);
  });
  await runInDurableObject(thread, (_instance, state) => {
    expect(state.storage.sql.exec('SELECT * FROM cleanup_attempts').toArray()).toHaveLength(2);
  });
});
