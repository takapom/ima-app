import type { ConversationCache } from '@mobile/platform/sqlite/conversation-cache';
import {
  parseConversation,
  parseConversationMessage,
  type ParseResult,
  type ConversationMessage,
} from '@ima/contracts';
import type { SqliteConnection, SqliteClock } from '@mobile/platform/sqlite/types';
import {
  conversationMessageDeadline,
  retainConversationMessage,
} from '@mobile/journey/services/conversations/conversation-retention';

/** The native composition opens a separate database for each credential and API endpoint. */
const requireParsed = <T>(parsed: ParseResult<T>): T => {
  if (!parsed.success) throw new Error('CONVERSATION_CACHE_INVALID');
  return parsed.data;
};
export const createConversationCache = (
  db: SqliteConnection,
  clock: SqliteClock,
): ConversationCache => {
  db.exec(
    'CREATE TABLE IF NOT EXISTS conversation_cache (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS conversation_message_cache (conversation_id TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL, expires_at REAL, PRIMARY KEY(conversation_id, id));',
  );
  const writeMessage = (message: ConversationMessage) => {
    const retained = retainConversationMessage(
      requireParsed(parseConversationMessage(message)),
      clock.now(),
    );
    db.prepare('INSERT OR REPLACE INTO conversation_message_cache VALUES (?, ?, ?, ?, ?)').run(
      retained.conversationId,
      retained.message.messageId,
      retained.sequence,
      JSON.stringify(retained),
      conversationMessageDeadline(retained),
    );
  };
  const cleanup = () => {
    for (const row of db
      .prepare('SELECT body FROM conversation_message_cache WHERE expires_at <= ?')
      .all(Date.parse(clock.now()))) {
      if (typeof row.body !== 'string') throw new Error('CONVERSATION_CACHE_INVALID');
      writeMessage(requireParsed(parseConversationMessage(JSON.parse(row.body))));
    }
  };
  return {
    cleanup,
    list: () => {
      cleanup();
      return db
        .prepare('SELECT body FROM conversation_cache ORDER BY updated_at DESC, id DESC')
        .all()
        .map((row) => {
          if (typeof row.body !== 'string') throw new Error('CONVERSATION_CACHE_INVALID');
          return requireParsed(parseConversation(JSON.parse(row.body)));
        });
    },
    messages: (id) => {
      cleanup();
      return db
        .prepare(
          'SELECT body FROM conversation_message_cache WHERE conversation_id = ? ORDER BY sequence ASC',
        )
        .all(id)
        .map((row) => {
          if (typeof row.body !== 'string') throw new Error('CONVERSATION_CACHE_INVALID');
          return requireParsed(parseConversationMessage(JSON.parse(row.body)));
        });
    },
    write: (conversation, messages) => {
      const parsed = requireParsed(parseConversation(conversation));
      if (messages.some((message) => message.conversationId !== parsed.conversationId))
        throw new Error('CONVERSATION_CACHE_SCOPE_MISMATCH');
      db.prepare('INSERT OR REPLACE INTO conversation_cache VALUES (?, ?, ?)').run(
        parsed.conversationId,
        parsed.updatedAt,
        JSON.stringify(parsed),
      );
      for (const message of messages) writeMessage(message);
      cleanup();
    },
    remove: (id) => {
      db.prepare('DELETE FROM conversation_message_cache WHERE conversation_id = ?').run(id);
      db.prepare('DELETE FROM conversation_cache WHERE id = ?').run(id);
    },
  };
};
