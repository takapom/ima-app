import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Conversation, ConversationMessage, RetentionMetadata } from '@ima/contracts';
import { createConversationCache } from '@mobile/platform/sqlite/conversations';
import type { SqliteConnection } from '@mobile/platform/sqlite/types';

const connection = (db: DatabaseSync): SqliteConnection => ({
  exec: (sql) => db.exec(sql),
  prepare: (sql) => {
    const statement = db.prepare(sql);
    return {
      run: (...values) => {
        statement.run(...values);
      },
      get: (...values) => statement.get(...values),
      all: (...values) => statement.all(...values),
    };
  },
});
const retained: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-21T11:00:00.000Z',
  freshUntil: '2026-09-21T10:30:00.000Z',
  displayUntil: '2026-09-21T11:00:00.000Z',
  retentionUntil: '2026-09-21T11:00:00.000Z',
  deletionScheduledAt: '2026-09-21T11:00:00.000Z',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};
describe('conversation SQLite cache', () => {
  it('invalidates legacy messages once and only marks a fully refetched history complete', () => {
    const db = new DatabaseSync(':memory:');
    const now = '2026-09-21T10:00:00.000Z';
    const conversation: Conversation = {
      conversationId: 'conversation',
      title: '会話',
      revision: 121,
      lastSequence: 120,
      createdAt: now,
      updatedAt: now,
    };
    const messages: ConversationMessage[] = Array.from({ length: 120 }, (_, index) => ({
      conversationId: conversation.conversationId,
      sequence: index + 1,
      createdAt: now,
      message: {
        messageId: `message-${index + 1}`,
        role: 'user',
        source: null,
        parts: [{ kind: 'user_text', text: `message ${index + 1}` }],
      },
    }));
    try {
      db.exec(
        'CREATE TABLE conversation_cache (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE conversation_message_cache (conversation_id TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL, expires_at REAL, PRIMARY KEY(conversation_id, id)); CREATE TABLE conversation_cache_completion_v2 (id TEXT PRIMARY KEY, revision INTEGER NOT NULL)',
      );
      db.prepare('INSERT INTO conversation_cache VALUES (?, ?, ?)').run(
        conversation.conversationId,
        conversation.updatedAt,
        JSON.stringify(conversation),
      );
      for (const message of messages)
        db.prepare('INSERT INTO conversation_message_cache VALUES (?, ?, ?, ?, NULL)').run(
          message.conversationId,
          message.message.messageId,
          message.sequence,
          JSON.stringify(message),
        );
      db.prepare('INSERT INTO conversation_cache_completion_v2 VALUES (?, ?)').run(
        conversation.conversationId,
        conversation.revision,
      );

      const cache = createConversationCache(connection(db), { now: () => now });
      expect(cache.list()).toEqual([conversation]);
      expect(cache.page(conversation.conversationId).messages).toEqual([]);
      expect(cache.completeRevision(conversation.conversationId)).toBeNull();

      cache.write(conversation, messages.slice(70));
      cache.markComplete(conversation);
      expect(cache.page(conversation.conversationId).messages).toHaveLength(50);
      expect(cache.completeRevision(conversation.conversationId)).toBeNull();

      cache.write(conversation, messages.slice(0, 70));
      cache.markComplete(conversation);
      expect(cache.completeRevision(conversation.conversationId)).toBe(conversation.revision);

      const reopened = createConversationCache(connection(db), { now: () => now });
      expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_message_cache').get()).toEqual({
        count: 120,
      });
      expect(reopened.completeRevision(conversation.conversationId)).toBe(conversation.revision);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_cache_completion_v2'")
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it('restores within one owner database, physically expires assistant text, and deletes both tables', () => {
    const db = new DatabaseSync(':memory:');
    const other = new DatabaseSync(':memory:');
    let now = '2026-09-21T10:00:00.000Z';
    try {
      const cache = createConversationCache(connection(db), { now: () => now });
      const conversation: Conversation = {
        conversationId: 'conversation',
        title: '会話',
        revision: 3,
        lastSequence: 2,
        createdAt: now,
        updatedAt: now,
      };
      const messages: ConversationMessage[] = [
        {
          conversationId: 'conversation',
          sequence: 1,
          createdAt: now,
          message: {
            messageId: 'user',
            role: 'user',
            source: null,
            parts: [{ kind: 'user_text', text: '長期間残す発言' }],
          },
        },
        {
          conversationId: 'conversation',
          sequence: 2,
          createdAt: now,
          message: {
            messageId: 'assistant',
            role: 'assistant',
            source: { threadId: 'thread', turnId: 'turn', responseId: 'response' },
            parts: [{ kind: 'retained_text', text: '期限付きの回答', retention: retained }],
          },
        },
      ];
      cache.setRecent([conversation]);
      cache.write(conversation, messages);
      expect(
        createConversationCache(connection(db), { now: () => now }).page('conversation').messages,
      ).toEqual(messages);
      expect(createConversationCache(connection(other), { now: () => now }).list()).toEqual([]);
      now = '2026-09-22T10:00:00.000Z';
      const expired = cache.page('conversation').messages;
      expect(expired[0]?.message.parts).toEqual(messages[0]?.message.parts);
      expect(expired[1]?.message.parts).toEqual([{ kind: 'unavailable', reason: 'expired' }]);
      expect(
        JSON.stringify(db.prepare('SELECT body FROM conversation_message_cache').all()),
      ).not.toContain('期限付きの回答');
      cache.remove('conversation');
      expect(cache.list()).toEqual([]);
      expect(cache.page('conversation').messages).toEqual([]);
    } finally {
      db.close();
      other.close();
    }
  });
});
