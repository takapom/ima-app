import type { ConversationMemoryStore } from '@worker/application/ports/conversation-memory-store';
import * as v from 'valibot';
import {
  AssistantResponseSchema,
  type AssistantResponse,
  type ConversationTurnRequest,
  type ThreadTurnRequest,
} from '@ima/contracts';
import type { ConversationStore } from '@worker/application/ports/conversation-store';
import type { ConversationRuns } from '@worker/application/ports/conversation-runs';
import type {
  ConversationRunResult,
  ConversationRunScope,
} from '@worker/application/ports/conversation-runs';
import type {
  ThreadSnapshotResult,
  ThreadDeleteResult,
} from '@worker/runtime/threads/thread-types';
import type {
  ThreadRuntimeTurnInput,
  ThreadRuntimeTurnResult,
  ThreadRuntimeFailureCode,
  ThreadRuntimeCancelResult,
} from '@worker/runtime/threads/admission';
import type {
  ConversationDelivery,
  ConversationDeliveryScope,
} from '@worker/runtime/conversations/conversation-delivery';

export type ConversationThreadNamespace = {
  readonly getByName: (name: string) => {
    initialize(
      owner: string,
      threadId: string,
      requireActiveSession?: boolean,
    ): Promise<ThreadSnapshotResult>;
    read(owner: string): Promise<ThreadSnapshotResult>;
    deleteThread(
      owner: string,
      turnId: string | null,
      revision: number | null,
      idempotencyKey: string,
    ): Promise<ThreadDeleteResult>;
    cancelRuntimeTurn(input: unknown): Promise<ThreadRuntimeCancelResult>;
    runConversationTurn(
      scope: ConversationDeliveryScope,
      input: ThreadRuntimeTurnInput,
    ): Promise<ThreadRuntimeTurnResult>;
    readConversationDelivery(
      scope: ConversationDeliveryScope,
    ): Promise<ConversationDelivery | null>;
    acknowledgeConversationDelivery(scope: ConversationDeliveryScope): Promise<void>;
  };
};

export const conversationFingerprint = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export class ConversationExecution {
  constructor(
    private readonly options: {
      readonly store: ConversationStore & ConversationRuns & ConversationMemoryStore;
      readonly threads: ConversationThreadNamespace;
      readonly now: () => string;
      readonly onFailure?: (code: ThreadRuntimeFailureCode) => void;
      readonly onResponse: (scope: ConversationRunScope, response: AssistantResponse) => void;
    },
  ) {}

  async reconcile(scope: ConversationRunScope): Promise<ConversationRunResult> {
    const result = await this.options.store.readRun(scope);
    if (!result.ok || result.run.threadId === null) return result;
    const stub = this.options.threads.getByName(result.run.threadId);
    const delivery = await stub.readConversationDelivery(scope);
    if (delivery === null) return result;
    if (delivery.response !== undefined) this.options.onResponse(scope, delivery.response);
    const completed = await this.options.store.complete({
      ...scope,
      now: this.options.now(),
      message: delivery.message,
      inputFingerprint: delivery.inputFingerprint,
    });
    if (completed.ok || completed.code === 'NOT_FOUND')
      await stub.acknowledgeConversationDelivery(scope);
    return completed;
  }

  async cancel(scope: ConversationRunScope): Promise<ConversationRunResult> {
    const result = await this.reconcile(scope);
    if (!result.ok || (result.run.status !== 'accepted' && result.run.status !== 'running'))
      return result;
    if (result.run.threadId !== null && result.run.turnId !== null) {
      const stub = this.options.threads.getByName(result.run.threadId);
      const thread = await stub.initialize(scope.ownerScopeRef, result.run.threadId, true);
      if (thread.ok)
        await stub.cancelRuntimeTurn({
          ownerScopeRef: scope.ownerScopeRef,
          threadId: result.run.threadId,
          turnId: result.run.turnId,
          revision: thread.snapshot.revision,
        });
      const reconciled = await this.reconcile(scope);
      if (!reconciled.ok || reconciled.run.status === 'completed') return reconciled;
    }
    return this.options.store.fail({ ...scope, now: this.options.now(), interrupted: true });
  }

  async execute(input: {
    readonly scope: ConversationRunScope;
    readonly request: ConversationTurnRequest;
    readonly deviceId: string;
    readonly previousThreadId: string | null;
  }): Promise<void> {
    const { scope, request } = input;
    const current = await this.options.store.readRun(scope);
    if (!current.ok || current.run.status !== 'accepted') return;
    let threadId = input.previousThreadId ?? `thread-${scope.runId}`;
    let thread = await this.options.threads
      .getByName(threadId)
      .initialize(scope.ownerScopeRef, threadId, true);
    if (!thread.ok || !thread.snapshot.active) {
      threadId = `thread-${scope.runId}`;
      thread = await this.options.threads
        .getByName(threadId)
        .initialize(scope.ownerScopeRef, threadId, true);
    }
    if (!thread.ok) throw new Error('CONVERSATION_THREAD_UNAVAILABLE');
    const turnId = `turn-${scope.runId}`;
    const started = await this.options.store.start({
      ...scope,
      threadId,
      turnId,
      now: this.options.now(),
    });
    if (!started.ok || started.run.status !== 'running') return;
    const projection = await this.options.store.loadMemory({
      ownerScopeRef: scope.ownerScopeRef,
      conversationId: scope.conversationId,
      now: this.options.now(),
      beforeSequence: current.run.inputSequence,
    });
    if (!projection.ok) throw new Error('CONVERSATION_MEMORY_UNAVAILABLE');
    const memory = projection.memory;
    const { expectedRevision, clientMessageId, ...turnFields } = request;
    if (
      expectedRevision + 1 !== current.conversation.revision ||
      clientMessageId !== current.run.userMessageId
    )
      throw new Error('CONVERSATION_ADMISSION_MISMATCH');
    const freshThread = threadId !== input.previousThreadId;
    const turnRequest: ThreadTurnRequest = {
      ...turnFields,
      revision: thread.snapshot.revision,
      turnId,
      ...(freshThread
        ? {
            cardSetId: null,
            promotedCandidateId: null,
            selectedCandidateId: null,
            candidateOrder: [],
            excludeCandidateIds: [],
          }
        : {}),
    };
    const result = await this.options.threads.getByName(threadId).runConversationTurn(scope, {
      ownerScopeRef: scope.ownerScopeRef,
      threadId,
      turnId,
      revision: thread.snapshot.revision,
      idempotencyKey: request.idempotencyKey,
      deviceId: input.deviceId,
      input: turnRequest,
      conversationMemory: memory,
    });
    if (result.status !== 'completed') {
      this.options.onFailure?.(result.code ?? 'RUNTIME_FAILED');
      await this.options.store.fail({ ...scope, now: this.options.now(), interrupted: false });
      return;
    }
    const completed = await this.reconcile(scope);
    const response = v.safeParse(AssistantResponseSchema, result.response);
    if (completed.ok && completed.run.status === 'completed' && response.success)
      this.options.onResponse(scope, response.output);
  }
}
