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
      cache.write(conversation, messages);
      expect(
        createConversationCache(connection(db), { now: () => now }).messages('conversation'),
      ).toEqual(messages);
      expect(createConversationCache(connection(other), { now: () => now }).list()).toEqual([]);
      now = '2026-09-22T10:00:00.000Z';
      const expired = cache.messages('conversation');
      expect(expired[0]?.message.parts).toEqual(messages[0]?.message.parts);
      expect(expired[1]?.message.parts).toEqual([{ kind: 'unavailable', reason: 'expired' }]);
      expect(
        JSON.stringify(db.prepare('SELECT body FROM conversation_message_cache').all()),
      ).not.toContain('期限付きの回答');
      cache.remove('conversation');
      expect(cache.list()).toEqual([]);
      expect(cache.messages('conversation')).toEqual([]);
    } finally {
      db.close();
      other.close();
    }
  });
});
