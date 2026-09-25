import { describe, expect, it, vi } from 'vitest';
import { ConversationExecutionApplication } from '@worker/application/use-cases/conversations/conversation-execution';
import type {
  ConversationRuns,
  ConversationRunResult,
} from '@worker/application/ports/conversation-runs';
import type {
  ConversationThreadPort,
  ConversationTurnExecutor,
} from '@worker/application/ports/conversation-execution';
import type { ConversationMemoryStore } from '@worker/application/ports/conversation-memory-store';
import type { ConversationRun } from '@worker/domain/conversations/conversation-run';

const now = '2026-09-10T00:00:00.000Z';
const scope = { ownerScopeRef: 'owner', conversationId: 'conversation', runId: 'run' };
const result = (status: ConversationRun['status']): ConversationRunResult => ({
  ok: true,
  replayed: false,
  conversation: {
    conversationId: scope.conversationId,
    ownerScopeRef: scope.ownerScopeRef,
    title: 'conversation',
    createdAt: now,
    updatedAt: now,
    revision: 2,
    lastSequence: 1,
  },
  run: {
    runId: scope.runId,
    conversationId: scope.conversationId,
    userMessageId: 'user-message',
    inputSequence: 1,
    status,
    createdAt: now,
    updatedAt: now,
    threadId: status === 'accepted' ? null : 'thread-run',
    turnId: status === 'accepted' ? null : 'turn-run',
    assistantMessageId: status === 'completed' ? 'answer' : null,
    failure: null,
  },
});
const delivery: NonNullable<Awaited<ReturnType<ConversationThreadPort['readDelivery']>>> = {
  inputFingerprint: 'fingerprint',
  message: {
    messageId: 'answer',
    role: 'assistant',
    source: { threadId: 'thread-run', turnId: 'turn-run', responseId: 'response' },
    parts: [{ kind: 'unavailable', reason: 'expired' }],
  },
};
const fixture = () => {
  const order: string[] = [];
  const store = {
    readRun: vi.fn<ConversationRuns['readRun']>(() => Promise.resolve(result('accepted'))),
    start: vi.fn<ConversationRuns['start']>(() => Promise.resolve(result('running'))),
    complete: vi.fn<ConversationRuns['complete']>(() => {
      order.push('complete');
      return Promise.resolve(result('completed'));
    }),
    fail: vi.fn<ConversationRuns['fail']>(() => Promise.resolve({ ok: false, code: 'NOT_FOUND' })),
    loadMemory: vi.fn<ConversationMemoryStore['loadMemory']>(() =>
      Promise.resolve({
        ok: true,
        memory: {
          ownerScopeRef: scope.ownerScopeRef,
          conversationId: scope.conversationId,
          beforeSequence: 1,
          entries: [],
        },
      }),
    ),
  };
  const threads = {
    initialize: vi.fn<ConversationThreadPort['initialize']>(() =>
      Promise.resolve({ active: true, revision: 1 }),
    ),
    readDelivery: vi.fn<ConversationThreadPort['readDelivery']>(() => Promise.resolve(delivery)),
    acknowledgeDelivery: vi.fn<ConversationThreadPort['acknowledgeDelivery']>(() => {
      order.push('ack');
      return Promise.resolve();
    }),
    cancel: vi.fn<ConversationThreadPort['cancel']>(() => Promise.resolve()),
  };
  const run = vi.fn<ConversationTurnExecutor>(() => Promise.resolve({ completed: true }));
  const application = new ConversationExecutionApplication({ store, threads, now: () => now });
  const input = {
    scope,
    expectedRevision: 1,
    clientMessageId: 'user-message',
    previousThreadId: 'old-thread',
  };
  return { application, store, threads, run, order, input };
};

describe('conversation execution application', () => {
  it('replaces an expired thread and resets candidates while loading only earlier memory', async () => {
    const f = fixture();
    f.threads.initialize.mockResolvedValueOnce({ active: false, revision: 8 });
    f.store.readRun
      .mockResolvedValueOnce(result('accepted'))
      .mockResolvedValueOnce(result('running'));
    const completed = await f.application.execute(f.input, f.run);
    expect(completed).toEqual(result('completed'));
    expect(f.run).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { ...scope, threadId: 'thread-run', turnId: 'turn-run', revision: 1 },
        resetCandidates: true,
      }),
    );
    expect(f.store.loadMemory).toHaveBeenCalledWith({
      ownerScopeRef: scope.ownerScopeRef,
      conversationId: scope.conversationId,
      beforeSequence: 1,
      now,
    });
    expect(f.order).toEqual(['complete', 'ack']);
  });

  it('keeps a delivery pending on conflict and acknowledges only after a successful retry', async () => {
    const f = fixture();
    f.store.readRun.mockResolvedValue(result('running'));
    f.store.complete.mockResolvedValueOnce({ ok: false, code: 'REVISION_CONFLICT' });
    expect(await f.application.reconcile(scope)).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    expect(f.threads.acknowledgeDelivery).not.toHaveBeenCalled();
    expect(await f.application.reconcile(scope)).toEqual(result('completed'));
    expect(f.threads.acknowledgeDelivery).toHaveBeenCalledTimes(1);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('consumes a delivery when the conversation has been deleted', async () => {
    const f = fixture();
    f.store.readRun.mockResolvedValue(result('running'));
    f.store.complete.mockResolvedValue({ ok: false, code: 'NOT_FOUND' });
    await f.application.reconcile(scope);
    expect(f.threads.acknowledgeDelivery).toHaveBeenCalledOnce();
  });

  it('keeps a completion delivered during cancellation completed', async () => {
    const f = fixture();
    f.store.readRun.mockResolvedValue(result('running'));
    f.threads.readDelivery.mockResolvedValueOnce(null).mockResolvedValueOnce(delivery);
    expect(await f.application.cancel(scope)).toEqual(result('completed'));
    expect(f.threads.cancel).toHaveBeenCalledOnce();
    expect(f.store.fail).not.toHaveBeenCalled();
  });

  it('leaves an unknown runtime outcome for durable reconciliation', async () => {
    const f = fixture();
    f.run.mockRejectedValue(new Error('RPC response lost'));
    await expect(f.application.execute(f.input, f.run)).rejects.toThrow('RPC response lost');
    expect(f.store.start).toHaveBeenCalledOnce();
    expect(f.store.fail).not.toHaveBeenCalled();
    expect(f.threads.acknowledgeDelivery).not.toHaveBeenCalled();
  });

  it('does not regenerate a run that is already completed', async () => {
    const f = fixture();
    f.store.readRun.mockResolvedValue(result('completed'));
    await f.application.execute(f.input, f.run);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.store.start).not.toHaveBeenCalled();
  });
});
