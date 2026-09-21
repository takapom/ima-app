import * as v from 'valibot';
import type {
  ConversationScope,
  ConversationStore,
} from '@worker/application/ports/conversation-store';
import {
  ConversationSchema,
  conversationTitleFromUserText,
} from '@worker/domain/conversations/conversation';
import {
  ConversationMessageSchema,
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
import {
  initializeConversationStorage,
  storeFailure,
  type ConversationSqlStorage,
  type JsonRow,
} from '@worker/adapters/out/persistence/conversations/conversation-sql-schema';

type Input<K extends keyof ConversationStore> = Parameters<ConversationStore[K]>[0];
type Result<K extends keyof ConversationStore> = Awaited<ReturnType<ConversationStore[K]>>;

export const messageDeadline = (message: Pick<ConversationMessage, 'message'>): number | null => {
  const deadlines = message.message.parts.flatMap((part) =>
    part.kind !== 'retained_text'
      ? []
      : [
          part.retention.sessionExpiresAt,
          part.retention.displayUntil,
          part.retention.retentionUntil,
          part.retention.deletionScheduledAt,
        ]
          .filter((date): date is string => date !== null)
          .map(Date.parse),
  );
  return deadlines.length === 0 ? null : Math.min(...deadlines);
};

/** Synchronous SQL operations allow run acceptance/completion to share the same short transaction. */
export class SqlConversationRecords {
  constructor(readonly storage: ConversationSqlStorage) {
    initializeConversationStorage(storage);
  }

  read(scope: ConversationScope): Result<'read'> {
    if (
      !v.safeParse(ConversationScopeSchema, {
        ownerScopeRef: scope.ownerScopeRef,
        conversationId: scope.conversationId,
      }).success
    )
      return storeFailure('INVALID_INPUT');
    const row = this.storage.sql
      .exec<JsonRow>(
        'SELECT body FROM conversations WHERE owner = ? AND id = ? AND body IS NOT NULL',
        scope.ownerScopeRef,
        scope.conversationId,
      )
      .toArray()[0];
    if (row === undefined) return storeFailure('NOT_FOUND');
    return { ok: true, conversation: v.parse(ConversationSchema, JSON.parse(row.body)) };
  }

  create(value: Input<'create'>): Result<'create'> {
    const parsed = v.safeParse(CreateConversationInputSchema, value);
    if (!parsed.success) return storeFailure('INVALID_INPUT');
    const input = parsed.output;
    return this.storage.transactionSync(() => {
      const prior = this.storage.sql
        .exec<{ conversation_id: string }>(
          'SELECT conversation_id FROM conversation_creations WHERE owner = ? AND key = ?',
          input.ownerScopeRef,
          input.idempotencyKey,
        )
        .toArray()[0];
      if (prior !== undefined) {
        if (prior.conversation_id !== input.conversationId)
          return storeFailure('IDEMPOTENCY_CONFLICT');
        const result = this.read(input);
        return result.ok ? { ...result, replayed: true } : result;
      }
      const exists = this.storage.sql
        .exec<{ body: string | null }>(
          'SELECT body FROM conversations WHERE owner = ? AND id = ?',
          input.ownerScopeRef,
          input.conversationId,
        )
        .toArray()[0];
      if (exists !== undefined)
        return storeFailure(exists.body === null ? 'NOT_FOUND' : 'IDEMPOTENCY_CONFLICT');
      const now = new Date(input.now).toISOString();
      const conversation = v.parse(ConversationSchema, {
        conversationId: input.conversationId,
        ownerScopeRef: input.ownerScopeRef,
        title: '新しい会話',
        createdAt: now,
        updatedAt: now,
        revision: 1,
        lastSequence: 0,
      });
      this.storage.sql.exec(
        'INSERT INTO conversations VALUES (?, ?, ?, ?)',
        input.ownerScopeRef,
        input.conversationId,
        JSON.stringify(conversation),
        now,
      );
      this.storage.sql.exec(
        'INSERT INTO conversation_creations VALUES (?, ?, ?)',
        input.ownerScopeRef,
        input.idempotencyKey,
        input.conversationId,
      );
      return { ok: true, conversation, replayed: false };
    });
  }

  list(value: Input<'list'>): Result<'list'> {
    const parsed = v.safeParse(ListConversationsInputSchema, value);
    if (!parsed.success) return storeFailure('INVALID_INPUT');
    const { ownerScopeRef, before, limit } = parsed.output;
    const cursorTime = before === null ? null : new Date(before.updatedAt).toISOString();
    const rows = this.storage.sql
      .exec<JsonRow>(
        `SELECT body FROM conversations WHERE owner = ? AND body IS NOT NULL
      AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC, id DESC LIMIT ?`,
        ownerScopeRef,
        cursorTime,
        cursorTime,
        cursorTime,
        before?.conversationId ?? null,
        limit + 1,
      )
      .toArray();
    const conversations = rows
      .slice(0, limit)
      .map((row) => v.parse(ConversationSchema, JSON.parse(row.body)));
    const last = conversations.at(-1);
    return {
      ok: true,
      conversations,
      nextCursor:
        rows.length > limit && last !== undefined
          ? { updatedAt: last.updatedAt, conversationId: last.conversationId }
          : null,
    };
  }

  append(value: Input<'append'>): Result<'append'> {
    const parsed = v.safeParse(AppendConversationMessageInputSchema, value);
    if (!parsed.success) return storeFailure('INVALID_INPUT');
    return this.storage.transactionSync(() => this.appendInTransaction(parsed.output));
  }

  private appendInTransaction(input: Input<'append'>): Result<'append'> {
    const current = this.read(input);
    if (!current.ok) return current;
    const scope = [input.ownerScopeRef, input.conversationId];
    const prior = this.storage.sql
      .exec<{ fingerprint: string; message_id: string; revision: number }>(
        'SELECT fingerprint, message_id, revision FROM conversation_operations WHERE owner = ? AND conversation_id = ? AND key = ?',
        ...scope,
        input.idempotencyKey,
      )
      .toArray()[0];
    if (prior !== undefined) {
      if (
        prior.fingerprint !== input.inputFingerprint ||
        prior.message_id !== input.message.messageId ||
        prior.revision !== input.expectedRevision
      )
        return storeFailure('IDEMPOTENCY_CONFLICT');
      const row = this.storage.sql
        .exec<JsonRow>(
          'SELECT body FROM conversation_messages WHERE owner = ? AND conversation_id = ? AND id = ?',
          ...scope,
          prior.message_id,
        )
        .one();
      const message = retainConversationMessage(
        v.parse(ConversationMessageSchema, JSON.parse(row.body)),
        input.now,
      );
      this.writeMessage(input, message);
      return { ...current, message, replayed: true };
    }
    if (
      this.storage.sql
        .exec(
          'SELECT id FROM conversation_messages WHERE owner = ? AND conversation_id = ? AND id = ?',
          ...scope,
          input.message.messageId,
        )
        .toArray().length > 0
    )
      return storeFailure('IDEMPOTENCY_CONFLICT');
    const previous = current.conversation;
    if (previous.revision !== input.expectedRevision) return storeFailure('REVISION_CONFLICT');
    if (
      previous.revision === Number.MAX_SAFE_INTEGER ||
      Date.parse(input.now) < Date.parse(previous.updatedAt)
    )
      return storeFailure('INVALID_INPUT');
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
    const firstPart =
      previous.lastSequence === 0 && input.message.role === 'user'
        ? input.message.parts[0]
        : undefined;
    const conversation = {
      ...previous,
      title:
        firstPart?.kind === 'user_text'
          ? conversationTitleFromUserText(firstPart.text)
          : previous.title,
      revision: previous.revision + 1,
      lastSequence: message.sequence,
      updatedAt: now,
    };
    this.writeMessage(input, message);
    this.storage.sql.exec(
      'UPDATE conversations SET body = ?, updated_at = ? WHERE owner = ? AND id = ?',
      JSON.stringify(conversation),
      now,
      ...scope,
    );
    this.storage.sql.exec(
      'INSERT INTO conversation_operations VALUES (?, ?, ?, ?, ?, ?)',
      ...scope,
      input.idempotencyKey,
      input.inputFingerprint,
      input.message.messageId,
      input.expectedRevision,
    );
    return { ok: true, conversation, message, replayed: false };
  }

  private writeMessage(scope: ConversationScope, message: ConversationMessage): void {
    this.storage.sql.exec(
      'INSERT OR REPLACE INTO conversation_messages VALUES (?, ?, ?, ?, ?, ?)',
      scope.ownerScopeRef,
      scope.conversationId,
      message.message.messageId,
      message.sequence,
      JSON.stringify(message),
      messageDeadline(message),
    );
  }

  messages(value: Input<'messages'>): Result<'messages'> {
    const parsed = v.safeParse(ReadConversationMessagesInputSchema, value);
    if (!parsed.success) return storeFailure('INVALID_INPUT');
    const input = parsed.output;
    const current = this.read(input);
    if (!current.ok) return current;
    const rows = this.storage.sql
      .exec<JsonRow>(
        `SELECT body FROM conversation_messages WHERE owner = ? AND conversation_id = ?
      AND (? IS NULL OR sequence < ?) ORDER BY sequence DESC LIMIT ?`,
        input.ownerScopeRef,
        input.conversationId,
        input.beforeSequence,
        input.beforeSequence,
        input.limit + 1,
      )
      .toArray();
    const messages = rows
      .slice(0, input.limit)
      .map((row) =>
        retainConversationMessage(
          v.parse(ConversationMessageSchema, JSON.parse(row.body)),
          input.now,
        ),
      )
      .reverse();
    this.storage.transactionSync(() => {
      for (const message of messages) this.writeMessage(input, message);
    });
    return {
      ok: true,
      messages,
      nextBeforeSequence: rows.length > input.limit ? (messages[0]?.sequence ?? null) : null,
    };
  }

  remove(scope: ConversationScope): Result<'remove'> {
    if (!v.safeParse(ConversationScopeSchema, scope).success) return storeFailure('INVALID_INPUT');
    return this.storage.transactionSync(() => {
      const current = this.read(scope);
      this.storage.sql.exec(
        'UPDATE conversations SET body = NULL WHERE owner = ? AND id = ?',
        scope.ownerScopeRef,
        scope.conversationId,
      );
      for (const table of [
        'conversation_messages',
        'conversation_operations',
        'conversation_runs',
        'conversation_summaries',
      ]) {
        this.storage.sql.exec(
          `DELETE FROM ${table} WHERE owner = ? AND conversation_id = ?`,
          scope.ownerScopeRef,
          scope.conversationId,
        );
      }
      return { ok: true, deleted: current.ok };
    });
  }

  purge(now: string): void {
    this.storage.transactionSync(() => {
      const rows = this.storage.sql
        .exec<{ owner: string; conversation_id: string; body: string }>(
          'SELECT owner, conversation_id, body FROM conversation_messages WHERE expires_at <= ? LIMIT 100',
          Date.parse(now),
        )
        .toArray();
      for (const row of rows)
        this.writeMessage(
          { ownerScopeRef: row.owner, conversationId: row.conversation_id },
          retainConversationMessage(v.parse(ConversationMessageSchema, JSON.parse(row.body)), now),
        );
    });
  }
}
