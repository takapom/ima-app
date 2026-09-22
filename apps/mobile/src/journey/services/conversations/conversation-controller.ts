import type {
  Conversation,
  ConversationMessage,
  ConversationRun,
  ConversationRunResponse,
  ConversationTurnRequest,
} from '@ima/contracts';
import type { ConversationClient } from '@mobile/platform/http/conversation-client';
import type { ConversationCache } from '@mobile/platform/sqlite/conversation-cache';
import {
  resultData,
  mergeMessages,
} from '@mobile/journey/services/conversations/conversation-controller-support';
import {
  applyAssistantResponse,
  createAssistantResponseState,
  type AssistantResponseState,
} from '@mobile/journey/state/assistant-response';
import { retainConversationMessage } from '@mobile/journey/services/conversations/conversation-retention';

export type ConversationState = {
  readonly conversations: readonly Conversation[];
  readonly selected: Conversation | null;
  readonly messages: readonly ConversationMessage[];
  readonly run: ConversationRun | null;
  readonly responseState: AssistantResponseState | null;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly listError: boolean;
  readonly error: string | null;
  readonly syncError: string | null;
  readonly nextCursor: string | null;
  readonly beforeSequence: number | null;
};
const initialState = (): ConversationState => ({
  conversations: [],
  selected: null,
  messages: [],
  run: null,
  responseState: null,
  loading: false,
  pending: false,
  listError: false,
  error: null,
  syncError: null,
  nextCursor: null,
  beforeSequence: null,
});
const pendingRun = (run: ConversationRun | null) =>
  run?.status === 'accepted' || run?.status === 'running';

export class ConversationController {
  private state = initialState();
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private listEpoch = 0;
  private abort = new AbortController();
  private createKey: string | null = null;
  private retryable: { id: string; request: ConversationTurnRequest } | null = null;
  private disposed = false;
  private draft: ConversationTurnRequest | null = null;
  constructor(
    private readonly options: {
      readonly client: ConversationClient;
      readonly cache?: ConversationCache;
      readonly id: () => string;
      readonly now: () => string;
      readonly onDisplay: (state: AssistantResponseState | null) => void;
    },
  ) {}
  reportError = (): void => {
    this.update({
      loading: false,
      pending: false,
      error: '会話を更新できませんでした。再取得してください。',
    });
  };
  getSnapshot = (): ConversationState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(changes: Partial<ConversationState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...changes };
    this.options.onDisplay(this.state.responseState);
    for (const listener of this.listeners) listener();
  }
  private current(epoch: number): boolean {
    return !this.disposed && this.epoch === epoch;
  }
  private invalidate(): number {
    this.abort.abort();
    this.abort = new AbortController();
    return ++this.epoch;
  }
  private cacheCurrent(): void {
    if (this.state.selected === null) return;
    try {
      this.options.cache?.write(this.state.selected, this.state.messages);
    } catch {
      this.update({
        error: '端末に履歴を保存できませんでした。会話はサーバーに保存されています。',
      });
    }
  }
  async activate(): Promise<void> {
    this.disposed = false;
    try {
      this.update({ conversations: this.options.cache?.list() ?? [] });
    } catch {
      this.update({ listError: true });
    }
    await this.refreshList();
  }
  async refreshList(more = false): Promise<void> {
    const epoch = ++this.listEpoch;
    try {
      const page = resultData(await this.options.client.list(more ? this.state.nextCursor : null));
      if (this.disposed || epoch !== this.listEpoch) return;
      this.update({
        conversations: more
          ? [
              ...new Map(
                [...this.state.conversations, ...page.conversations].map((item) => [
                  item.conversationId,
                  item,
                ]),
              ).values(),
            ]
          : page.conversations,
        nextCursor: page.nextCursor,
        listError: false,
      });
      try {
        for (const conversation of page.conversations) this.options.cache?.write(conversation, []);
      } catch {
        this.update({ error: '端末の履歴保存を利用できません。' });
      }
    } catch {
      if (!this.disposed && epoch === this.listEpoch) this.update({ listError: true });
    }
  }
  newConversation(): void {
    this.invalidate();
    this.createKey = null;
    this.retryable = null;
    this.draft = null;
    this.update({
      selected: null,
      messages: [],
      run: null,
      responseState: null,
      loading: false,
      pending: false,
      error: null,
      beforeSequence: null,
      syncError: null,
    });
  }
  async select(id: string): Promise<void> {
    const sameConversation = this.state.selected?.conversationId === id;
    const epoch = this.invalidate();
    if (!sameConversation) {
      this.retryable = null;
      this.draft = null;
    }
    let cached: readonly ConversationMessage[] = [];
    try {
      cached = this.options.cache?.messages(id) ?? [];
    } catch {
      /* Network read below supplies the authoritative state. */
    }
    this.update({
      selected: sameConversation
        ? this.state.selected
        : (this.state.conversations.find((item) => item.conversationId === id) ?? null),
      messages: sameConversation ? this.state.messages : cached,
      run: sameConversation ? this.state.run : null,
      responseState: sameConversation ? this.state.responseState : null,
      syncError: sameConversation ? this.state.syncError : null,
      loading: true,
      pending: false,
      error: null,
      beforeSequence: null,
    });
    try {
      const [detail, page] = await Promise.all([
        this.options.client.get(id, { signal: this.abort.signal }),
        this.options.client.messages(id, null, { signal: this.abort.signal }),
      ]);
      const selected = resultData(detail);
      const messages = resultData(page);
      if (!this.current(epoch)) return;
      if (
        selected.conversation.conversationId !== id ||
        messages.messages.some((item) => item.conversationId !== id)
      )
        throw new Error('CONVERSATION_SCOPE_MISMATCH');
      const run = selected.activeRun ?? (sameConversation ? this.state.run : null);
      this.update({
        selected: selected.conversation,
        messages: messages.messages,
        run,
        loading: false,
        pending: pendingRun(run),
        beforeSequence: messages.nextBeforeSequence,
        syncError: null,
      });
      this.cacheCurrent();
      if (run !== null && pendingRun(run)) await this.watch(id, run.runId, epoch);
    } catch (error) {
      if (!this.current(epoch)) return;
      if (error instanceof Error && error.message === 'NOT_FOUND') {
        try {
          this.options.cache?.remove(id);
        } catch {
          this.update({ listError: true });
        }
        this.newConversation();
        this.update({ error: 'この会話は削除されています。' });
        await this.refreshList();
      } else if (sameConversation && this.state.responseState !== null)
        this.update({
          loading: false,
          pending: false,
          syncError: '履歴を同期できませんでした。再取得してください。',
        });
      else
        this.update({
          loading: false,
          pending: false,
          error: '会話を読み込めませんでした。接続を確認して再取得してください。',
        });
    }
  }
  async older(): Promise<void> {
    const id = this.state.selected?.conversationId;
    const before = this.state.beforeSequence;
    if (id === undefined || before === null || this.state.loading) return;
    const epoch = this.epoch;
    this.update({ loading: true });
    try {
      const page = resultData(
        await this.options.client.messages(id, before, { signal: this.abort.signal }),
      );
      if (!this.current(epoch)) return;
      if (page.messages.some((item) => item.conversationId !== id))
        throw new Error('CONVERSATION_SCOPE_MISMATCH');
      this.update({
        messages: mergeMessages(page.messages, this.state.messages),
        beforeSequence: page.nextBeforeSequence,
        loading: false,
      });
      this.cacheCurrent();
    } catch {
      if (this.current(epoch))
        this.update({ loading: false, error: '以前の発言を読み込めませんでした。' });
    }
  }
  async submit(request: ConversationTurnRequest): Promise<void> {
    if (this.state.pending || this.state.loading) return;
    if (pendingRun(this.state.run)) {
      this.update({ error: '回答は処理中です。再取得または中断してください。' });
      return;
    }
    this.draft = request;
    const epoch = this.epoch;
    this.update({ pending: true, error: null });
    try {
      let selected = this.state.selected;
      if (selected === null) {
        this.createKey ??= this.options.id();
        const created = resultData(
          await this.options.client.create(
            { schemaVersion: 'v1', requestId: this.options.id(), idempotencyKey: this.createKey },
            { signal: this.abort.signal },
          ),
        );
        if (!this.current(epoch)) return;
        selected = created.conversation;
        this.update({ selected });
      }
      const input = { ...request, expectedRevision: selected.revision };
      this.retryable = { id: selected.conversationId, request: input };
      await this.sendRetryable(epoch);
    } catch {
      if (this.current(epoch))
        this.update({
          pending: false,
          error: '送信を確認できませんでした。同じ発言を再送できます。',
        });
    }
  }
  private async sendRetryable(epoch: number): Promise<void> {
    const pending = this.retryable;
    if (pending === null) return;
    const sent = await this.options.client.send(pending.id, pending.request, {
      signal: this.abort.signal,
    });
    if (!this.current(epoch)) return;
    if (!sent.ok && sent.error.kind === 'http' && sent.error.status === 409) {
      this.retryable = null;
      this.draft = {
        ...pending.request,
        clientMessageId: this.options.id(),
        idempotencyKey: this.options.id(),
      };
      const refreshedEpoch = this.epoch + 1;
      await this.select(pending.id);
      if (this.current(refreshedEpoch) && this.state.selected?.conversationId === pending.id)
        this.update({ error: '会話が更新されています。履歴を確認して再送してください。' });
      return;
    }
    const result = resultData(sent);
    if (
      result.conversation.conversationId !== pending.id ||
      result.run.userMessageId !== pending.request.clientMessageId
    )
      throw new Error('CONVERSATION_SCOPE_MISMATCH');
    const userMessage: ConversationMessage = {
      conversationId: pending.id,
      sequence: result.run.inputSequence,
      createdAt: result.run.createdAt,
      message: {
        messageId: pending.request.clientMessageId,
        role: 'user',
        source: null,
        parts: [{ kind: 'user_text', text: pending.request.text }],
      },
    };
    this.update({
      selected: result.conversation,
      messages: mergeMessages(this.state.messages, [userMessage]),
      run: result.run,
      pending: pendingRun(result.run),
    });
    this.retryable = null;
    this.draft = null;
    this.cacheCurrent();
    await this.refreshList();
    if (!this.current(epoch)) return;
    if (pendingRun(result.run)) await this.watch(pending.id, result.run.runId, epoch);
    else await this.receive(result, epoch);
  }
  private async receive(value: ConversationRunResponse, epoch: number): Promise<void> {
    if (!this.current(epoch) || this.state.selected?.conversationId !== value.run.conversationId)
      return;
    let responseState = this.state.responseState;
    if (value.response !== null)
      responseState = applyAssistantResponse(
        responseState?.threadId === value.response.threadId
          ? responseState
          : createAssistantResponseState(value.response.threadId),
        value.response,
      );
    this.update({
      selected: value.conversation,
      run: value.run,
      pending: pendingRun(value.run),
      responseState,
      error:
        value.run.status === 'failed' || value.run.status === 'interrupted'
          ? '回答を完了できませんでした。発言は保存されています。新しい発言を送れます。'
          : null,
    });
    if (!pendingRun(value.run)) {
      try {
        const page = resultData(
          await this.options.client.messages(value.conversation.conversationId, null, {
            signal: this.abort.signal,
          }),
        );
        if (!this.current(epoch)) return;
        if (page.messages.some((message) => message.conversationId !== value.run.conversationId))
          throw new Error('CONVERSATION_SCOPE_MISMATCH');
        this.update({
          messages: mergeMessages(this.state.messages, page.messages),
          beforeSequence: this.state.beforeSequence ?? page.nextBeforeSequence,
        });
        this.cacheCurrent();
        await this.refreshList();
        if (this.current(epoch)) this.update({ syncError: null });
      } catch {
        if (this.current(epoch))
          this.update({ syncError: '回答の状態は確認済みですが、履歴を同期できませんでした。' });
      }
    }
  }
  private async watch(id: string, runId: string, epoch: number): Promise<void> {
    const last: { value: ConversationRunResponse | null } = { value: null };
    try {
      await this.options.client.watch(
        id,
        runId,
        (value) => {
          if (!this.current(epoch)) return;
          last.value = value;
          this.update({ run: value.run, pending: pendingRun(value.run) });
        },
        this.abort.signal,
      );
    } catch {
      /* Fetch the durable run below; reconnecting never submits another turn. */
    }
    if (!this.current(epoch)) return;
    const result =
      last.value !== null && !pendingRun(last.value.run)
        ? last.value
        : resultData(await this.options.client.run(id, runId, { signal: this.abort.signal }));
    await this.receive(result, epoch);
    if (pendingRun(result.run))
      this.update({
        pending: false,
        error: '回答は処理中です。履歴を再取得して続きの状態を確認できます。',
      });
  }
  async retry(): Promise<void> {
    if (this.state.pending || this.state.loading) return;
    if (this.retryable === null) {
      if (this.draft !== null) {
        await this.submit(this.draft);
        return;
      }
      if (this.state.selected !== null) await this.select(this.state.selected.conversationId);
      return;
    }
    const epoch = this.epoch;
    this.update({ pending: true, error: null });
    try {
      await this.sendRetryable(epoch);
    } catch {
      if (this.current(epoch))
        this.update({
          pending: false,
          error: '送信を確認できませんでした。もう一度再送できます。',
        });
    }
  }
  async cancel(): Promise<void> {
    const run = this.state.run;
    if (run === null || !pendingRun(run)) return;
    const epoch = this.invalidate();
    this.update({ pending: true });
    try {
      await this.receive(
        resultData(await this.options.client.cancel(run.conversationId, run.runId)),
        epoch,
      );
    } catch {
      if (this.current(epoch))
        this.update({
          pending: false,
          error: '中断を確認できませんでした。履歴を再取得してください。',
        });
    }
  }
  async remove(id: string): Promise<void> {
    try {
      resultData(await this.options.client.remove(id));
      this.options.cache?.remove(id);
      if (this.state.selected?.conversationId === id) this.newConversation();
      await this.refreshList();
    } catch {
      this.update({ error: '会話を削除できませんでした。もう一度試してください。' });
    }
  }
  expire(): void {
    try {
      this.options.cache?.cleanup();
    } catch {
      this.update({ error: '端末の履歴保存を利用できません。' });
    }
    this.update({
      messages: this.state.messages.map((message) =>
        retainConversationMessage(message, this.options.now()),
      ),
    });
  }
  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.listEpoch++;
    this.listeners.clear();
    this.options.onDisplay(null);
  }
}
