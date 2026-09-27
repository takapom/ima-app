import type { Conversation } from '@ima/contracts';
import type { ConversationClient } from '@mobile/platform/http/conversation-client';
import type {
  ConversationCache,
  ConversationPage,
} from '@mobile/platform/sqlite/conversation-cache';
import { resultData } from '@mobile/journey/services/conversations/conversation-controller-support';

const yieldToUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Full cache hydration is independent from the page currently rendered on screen. */
export class ConversationHistory {
  private generation = 0;
  private active = true;
  private abort = new AbortController();
  constructor(
    private readonly client: ConversationClient,
    private readonly cache?: ConversationCache,
  ) {}
  activate(): void {
    this.active = true;
  }
  async purge(): Promise<void> {
    while (this.active && this.cache?.cleanup() === true) await yieldToUI();
  }
  dispose(): void {
    this.active = false;
    this.generation++;
    this.abort.abort();
  }
  async page(
    conversation: Conversation,
    before: number | null,
    signal: AbortSignal,
  ): Promise<ConversationPage> {
    try {
      if (this.cache?.completeRevision(conversation.conversationId) === conversation.revision)
        return this.cache.page(conversation.conversationId, before);
    } catch {
      /* Cache failure must not prevent the authoritative server read. */
    }
    return resultData(await this.client.messages(conversation.conversationId, before, { signal }));
  }
  async prefetch(conversations: readonly Conversation[]): Promise<void> {
    if (this.cache === undefined) return;
    const generation = ++this.generation;
    this.abort.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.cache.setRecent(conversations);
    await this.purge();
    for (const conversation of conversations.slice(0, 3)) {
      if (generation !== this.generation) return;
      if (this.cache.completeRevision(conversation.conversationId) === conversation.revision)
        continue;
      let before: number | null = null;
      do {
        const page: ConversationPage = resultData(
          await this.client.messages(conversation.conversationId, before, { signal }),
        );
        if (generation !== this.generation) return;
        if (
          page.messages.some((message) => message.conversationId !== conversation.conversationId) ||
          (before !== null && page.nextBeforeSequence !== null && page.nextBeforeSequence >= before)
        )
          throw new Error('CONVERSATION_PAGE_INVALID');
        this.cache.write(
          conversation,
          page.messages.filter((message) => message.sequence <= conversation.lastSequence),
        );
        before = page.nextBeforeSequence;
        await yieldToUI();
      } while (before !== null);
      const detail = resultData(await this.client.get(conversation.conversationId, { signal }));
      if (generation !== this.generation) return;
      if (detail.conversation.conversationId !== conversation.conversationId)
        throw new Error('CONVERSATION_SCOPE_MISMATCH');
      if (detail.conversation.revision === conversation.revision)
        this.cache.markComplete(conversation);
    }
  }
}
