import * as v from 'valibot';
import type {
  ConversationScope,
  ConversationStore,
  ConversationStoreFailure,
} from '@worker/application/ports/conversation-store';
import {
  conversationTitleFromUserText,
  type Conversation,
  type ConversationCursor,
} from '@worker/domain/conversations/conversation';
import {
  retainConversationMessage,
  type ConversationMessage,
} from '@worker/domain/conversations/conversation-message';
import {
  AppendConversationMessageInputSchema,
  ConversationScopeSchema,
  CreateConversationInputSchema,
  ListConversationsInputSchema,
  ReadConversationMessagesInputSchema,
} from '@worker/adapters/out/persistence/conversations/conversation-store-input';

type AppendOperation = {
  readonly fingerprint: string;
  readonly messageId: string;
  readonly expectedRevision: number;
};
type ConversationBucket = {
  conversation: Conversation;
  readonly messages: ConversationMessage[];
  readonly operations: Map<string, AppendOperation>;
};
type OwnerBucket = {
  readonly conversations: Map<string, ConversationBucket>;
  readonly created: Map<string, string>;
  readonly deletedIds: Set<string>;
};

const failure = (code: ConversationStoreFailure['code']): ConversationStoreFailure => ({
  ok: false,
  code,
});
const compareId = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const newestFirst = (left: ConversationCursor, right: ConversationCursor): number =>
  Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
  compareId(right.conversationId, left.conversationId);

/** Process-local adapter for contract tests; it is never a fallback for unavailable durable storage. */
export const createMemoryConversationStore = (): ConversationStore => {
  const owners = new Map<string, OwnerBucket>();
  const find = (scope: ConversationScope): ConversationBucket | undefined =>
    owners.get(scope.ownerScopeRef)?.conversations.get(scope.conversationId);

  const create: ConversationStore['create'] = (value) =>
    Promise.resolve().then(() => {
      const parsed = v.safeParse(CreateConversationInputSchema, value);
      if (!parsed.success) return failure('INVALID_INPUT');
      const input = parsed.output;
      let owner = owners.get(input.ownerScopeRef);
      if (owner === undefined) {
        owner = { conversations: new Map(), created: new Map(), deletedIds: new Set() };
        owners.set(input.ownerScopeRef, owner);
      }
      const priorId = owner.created.get(input.idempotencyKey);
      if (priorId !== undefined) {
        if (priorId !== input.conversationId) return failure('IDEMPOTENCY_CONFLICT');
        const prior = owner.conversations.get(priorId);
        return prior === undefined
          ? failure('NOT_FOUND')
          : {
              ok: true as const,
              conversation: structuredClone(prior.conversation),
              replayed: true,
            };
      }
      if (owner.deletedIds.has(input.conversationId)) return failure('NOT_FOUND');
      if (owner.conversations.has(input.conversationId)) return failure('IDEMPOTENCY_CONFLICT');
      const now = new Date(input.now).toISOString();
      const conversation: Conversation = {
        conversationId: input.conversationId,
        ownerScopeRef: input.ownerScopeRef,
        title: '新しい会話',
        createdAt: now,
        updatedAt: now,
        revision: 1,
        lastSequence: 0,
      };
      owner.conversations.set(input.conversationId, {
        conversation,
        messages: [],
        operations: new Map(),
      });
      owner.created.set(input.idempotencyKey, input.conversationId);
      return { ok: true, conversation: structuredClone(conversation), replayed: false };
    });

  const read: ConversationStore['read'] = (scope) =>
    Promise.resolve().then(() => {
      if (!v.safeParse(ConversationScopeSchema, scope).success) return failure('INVALID_INPUT');
      const bucket = find(scope);
      return bucket === undefined
        ? failure('NOT_FOUND')
        : { ok: true, conversation: structuredClone(bucket.conversation) };
    });

  const list: ConversationStore['list'] = (value) =>
    Promise.resolve().then(() => {
      const parsed = v.safeParse(ListConversationsInputSchema, value);
      if (!parsed.success) return failure('INVALID_INPUT');
      const { ownerScopeRef, before, limit } = parsed.output;
      const conversations = [...(owners.get(ownerScopeRef)?.conversations.values() ?? [])]
        .map((bucket) => bucket.conversation)
        .sort(newestFirst)
        .filter((conversation) => before === null || newestFirst(conversation, before) > 0);
      const page = conversations.slice(0, limit);
      const last = page.at(-1);
      return {
        ok: true,
        conversations: structuredClone(page),
        nextCursor:
          conversations.length > limit && last !== undefined
            ? { updatedAt: last.updatedAt, conversationId: last.conversationId }
            : null,
      };
    });

  const append: ConversationStore['append'] = (value) =>
    Promise.resolve().then(() => {
      const parsed = v.safeParse(AppendConversationMessageInputSchema, value);
      if (!parsed.success) return failure('INVALID_INPUT');
      const input = parsed.output;
      const bucket = find(input);
      if (bucket === undefined) return failure('NOT_FOUND');
      const prior = bucket.operations.get(input.idempotencyKey);
      if (prior !== undefined) {
        if (
          prior.fingerprint !== input.inputFingerprint ||
          prior.messageId !== input.message.messageId ||
          prior.expectedRevision !== input.expectedRevision
        ) {
          return failure('IDEMPOTENCY_CONFLICT');
        }
        const index = bucket.messages.findIndex(
          (message) => message.message.messageId === prior.messageId,
        );
        const message = bucket.messages[index];
        if (message === undefined) throw new Error('CORRUPT_CONVERSATION_OPERATION');
        const retained = retainConversationMessage(message, input.now);
        bucket.messages[index] = retained;
        return {
          ok: true as const,
          conversation: structuredClone(bucket.conversation),
          message: structuredClone(retained),
          replayed: true,
        };
      }
      if (bucket.messages.some((message) => message.message.messageId === input.message.messageId))
        return failure('IDEMPOTENCY_CONFLICT');
      const previous = bucket.conversation;
      if (previous.revision !== input.expectedRevision) return failure('REVISION_CONFLICT');
      if (
        previous.revision === Number.MAX_SAFE_INTEGER ||
        Date.parse(input.now) < Date.parse(previous.updatedAt)
      ) {
        return failure('INVALID_INPUT');
      }
      const now = new Date(input.now).toISOString();
      const message = retainConversationMessage(
        {
          conversationId: input.conversationId,
          sequence: previous.lastSequence + 1,
          createdAt: now,
          message: input.message,
        },
        now,
      );
      const firstUserPart =
        input.message.role === 'user' && previous.lastSequence === 0
          ? input.message.parts.find((part) => part.kind === 'user_text')
          : undefined;
      bucket.conversation = {
        ...previous,
        title:
          firstUserPart === undefined
            ? previous.title
            : conversationTitleFromUserText(firstUserPart.text),
        revision: previous.revision + 1,
        lastSequence: message.sequence,
        updatedAt: now,
      };
      bucket.messages.push(message);
      bucket.operations.set(input.idempotencyKey, {
        fingerprint: input.inputFingerprint,
        messageId: input.message.messageId,
        expectedRevision: input.expectedRevision,
      });
      return {
        ok: true,
        conversation: structuredClone(bucket.conversation),
        message: structuredClone(message),
        replayed: false,
      };
    });

  const messages: ConversationStore['messages'] = (value) =>
    Promise.resolve().then(() => {
      const parsed = v.safeParse(ReadConversationMessagesInputSchema, value);
      if (!parsed.success) return failure('INVALID_INPUT');
      const input = parsed.output;
      const bucket = find(input);
      if (bucket === undefined) return failure('NOT_FOUND');
      const eligible = bucket.messages
        .map((message, index) => {
          const retained = retainConversationMessage(message, input.now);
          bucket.messages[index] = retained;
          return retained;
        })
        .filter(
          (message) => input.beforeSequence === null || message.sequence < input.beforeSequence,
        );
      const page = eligible.slice(-input.limit);
      return {
        ok: true,
        messages: structuredClone(page),
        nextBeforeSequence: eligible.length > input.limit ? (page[0]?.sequence ?? null) : null,
      };
    });

  const remove: ConversationStore['remove'] = (scope) =>
    Promise.resolve().then(() => {
      if (!v.safeParse(ConversationScopeSchema, scope).success) return failure('INVALID_INPUT');
      const owner = owners.get(scope.ownerScopeRef);
      const deleted = owner?.conversations.delete(scope.conversationId) ?? false;
      if (deleted) owner?.deletedIds.add(scope.conversationId);
      return { ok: true, deleted };
    });

  return { create, read, list, append, messages, remove };
};
