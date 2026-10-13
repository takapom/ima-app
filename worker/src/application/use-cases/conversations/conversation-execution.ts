import type { ConversationMemoryStore } from '@worker/application/ports/conversation-memory-store';
import type {
  ConversationRuns,
  ConversationRunResult,
  ConversationRunScope,
} from '@worker/application/ports/conversation-runs';
import type {
  ConversationThreadPort,
  ConversationTurnExecutor,
} from '@worker/application/ports/conversation-execution';

/** 1回の AI 応答生成を開始するときの入力。会話の revision と clientMessageId で二重実行を防ぐ。 */
export type ConversationExecutionInput = {
  readonly scope: ConversationRunScope;
  readonly expectedRevision: number;
  readonly clientMessageId: string;
  readonly previousThreadId: string | null;
};

/**
 * 会話の1 run（ユーザー1発言に対する AI 処理）の状態を進める。
 * DB・SDK・DO との通信は port に任せ、ここでは start → 実行 → complete/fail の順序だけ決める。
 */
export class ConversationExecutionApplication {
  constructor(
    private readonly options: {
      readonly store: Pick<ConversationRuns, 'readRun' | 'start' | 'complete' | 'fail'> &
        ConversationMemoryStore;
      readonly threads: ConversationThreadPort;
      readonly now: () => string;
    },
  ) {}

  /**
   * スレッド側に届いている応答があれば run を completed に更新する。
   * 成功または会話削除（NOT_FOUND）のときだけ配送 ack を送る。それ以外は ack せず再試行可能にする。
   */
  async reconcile(scope: ConversationRunScope): Promise<ConversationRunResult> {
    const result = await this.options.store.readRun(scope);
    if (!result.ok || result.run.threadId === null) return result;
    const target = { ...scope, threadId: result.run.threadId };
    const delivery = await this.options.threads.readDelivery(target);
    if (delivery === null) return result;
    const completed = await this.options.store.complete({
      ...scope,
      now: this.options.now(),
      message: delivery.message,
      inputFingerprint: delivery.inputFingerprint,
    });
    if (completed.ok || completed.code === 'NOT_FOUND')
      await this.options.threads.acknowledgeDelivery(target);
    return completed;
  }

  /**
   * 進行中の turn を止める。
   * スレッドへ cancel を渡したあとにもう一度 reconcile し、配送済みの完了を中断失敗で上書きしない。
   */
  async cancel(scope: ConversationRunScope): Promise<ConversationRunResult> {
    const result = await this.reconcile(scope);
    if (!result.ok || (result.run.status !== 'accepted' && result.run.status !== 'running'))
      return result;
    if (result.run.threadId !== null && result.run.turnId !== null) {
      const thread = await this.options.threads.initialize(
        scope.ownerScopeRef,
        result.run.threadId,
      );
      if (thread !== undefined)
        await this.options.threads.cancel({
          ...scope,
          threadId: result.run.threadId,
          turnId: result.run.turnId,
          revision: thread.revision,
        });
      const reconciled = await this.reconcile(scope);
      if (!reconciled.ok || reconciled.run.status === 'completed') return reconciled;
    }
    return this.options.store.fail({ ...scope, now: this.options.now(), interrupted: true });
  }

  /**
   * accepted の run だけを running にして実行する。
   * 直前スレッドが無効なら run 専用のスレッドを作り、候補をリセットするかは実行側へ渡す。
   * 受付時の revision と clientMessageId が食い違うときは実行せず、受付の取り違えとして落とす。
   */
  async execute(
    input: ConversationExecutionInput,
    run: ConversationTurnExecutor,
  ): Promise<ConversationRunResult | undefined> {
    const { scope } = input;
    const current = await this.options.store.readRun(scope);
    if (!current.ok || current.run.status !== 'accepted') return undefined;
    let threadId = input.previousThreadId ?? `thread-${scope.runId}`;
    let thread = await this.options.threads.initialize(scope.ownerScopeRef, threadId);
    if (thread === undefined || !thread.active) {
      threadId = `thread-${scope.runId}`;
      thread = await this.options.threads.initialize(scope.ownerScopeRef, threadId);
    }
    if (thread === undefined) throw new Error('CONVERSATION_THREAD_UNAVAILABLE');
    const turnId = `turn-${scope.runId}`;
    const started = await this.options.store.start({
      ...scope,
      threadId,
      turnId,
      now: this.options.now(),
    });
    if (!started.ok || started.run.status !== 'running') return undefined;
    const projection = await this.options.store.loadMemory({
      ownerScopeRef: scope.ownerScopeRef,
      conversationId: scope.conversationId,
      now: this.options.now(),
      beforeSequence: current.run.inputSequence,
    });
    if (!projection.ok) throw new Error('CONVERSATION_MEMORY_UNAVAILABLE');
    if (
      input.expectedRevision + 1 !== current.conversation.revision ||
      input.clientMessageId !== current.run.userMessageId
    )
      throw new Error('CONVERSATION_ADMISSION_MISMATCH');
    const result = await run({
      target: { ...scope, threadId, turnId, revision: thread.revision },
      memory: projection.memory,
      resetCandidates: threadId !== input.previousThreadId,
    });
    if (!result.completed) {
      await this.options.store.fail({ ...scope, now: this.options.now(), interrupted: false });
      return undefined;
    }
    return this.reconcile(scope);
  }
}
