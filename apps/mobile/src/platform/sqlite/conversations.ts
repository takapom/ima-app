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

const requireParsed = <T>(parsed: ParseResult<T>): T => {
  if (!parsed.success) throw new Error('CONVERSATION_CACHE_INVALID');
  return parsed.data;
};
const body = (row: Record<string, unknown>): unknown => {
  if (typeof row.body !== 'string') throw new Error('CONVERSATION_CACHE_INVALID');
  return JSON.parse(row.body);
};
/** Owner/endpoint isolation is supplied by composition. Operations are bounded to one page. */
export const createConversationCache = (
  db: SqliteConnection,
  clock: SqliteClock,
): ConversationCache => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_cache (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation_message_cache (conversation_id TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL, expires_at REAL, PRIMARY KEY(conversation_id, id));
    CREATE TABLE IF NOT EXISTS conversation_cache_completion (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS conversation_cache_listing ON conversation_cache(updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS conversation_cache_sequence ON conversation_message_cache(conversation_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS conversation_cache_expiry ON conversation_message_cache(expires_at);
  `);
  const prune = () => {
    db.exec(`DELETE FROM conversation_cache WHERE id NOT IN (SELECT id FROM conversation_cache ORDER BY updated_at DESC, id DESC LIMIT 3);
      DELETE FROM conversation_message_cache WHERE conversation_id NOT IN (SELECT id FROM conversation_cache);
      DELETE FROM conversation_cache_completion WHERE id NOT IN (SELECT id FROM conversation_cache);`);
  };
  prune();
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
    return retained;
  };
  const cleanup = (): boolean => {
    const rows = db
      .prepare('SELECT body FROM conversation_message_cache WHERE expires_at <= ? LIMIT 100')
      .all(Date.parse(clock.now()));
    for (const row of rows) writeMessage(requireParsed(parseConversationMessage(body(row))));
    return rows.length === 100;
  };
  const remove = (id: string) => {
    db.prepare('DELETE FROM conversation_message_cache WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM conversation_cache_completion WHERE id = ?').run(id);
    db.prepare('DELETE FROM conversation_cache WHERE id = ?').run(id);
  };
  const metadata = (id: string) => {
    const row = db.prepare('SELECT body FROM conversation_cache WHERE id = ?').get(id);
    return row === undefined ? null : requireParsed(parseConversation(body(row)));
  };
  return {
    cleanup,
    remove,
    list: () =>
      db
        .prepare('SELECT body FROM conversation_cache ORDER BY updated_at DESC, id DESC LIMIT 3')
        .all()
        .map((row) => requireParsed(parseConversation(body(row)))),
    setRecent: (conversations) => {
      const recent = conversations
        .slice(0, 3)
        .map((value) => requireParsed(parseConversation(value)));
      for (const row of db.prepare('SELECT id FROM conversation_cache').all()) {
        if (typeof row.id !== 'string') throw new Error('CONVERSATION_CACHE_INVALID');
        if (!recent.some((item) => item.conversationId === row.id)) remove(row.id);
      }
      for (const conversation of recent) {
        const current = metadata(conversation.conversationId);
        if (current !== null && current.revision > conversation.revision) continue;
        db.prepare('INSERT OR REPLACE INTO conversation_cache VALUES (?, ?, ?)').run(
          conversation.conversationId,
          conversation.updatedAt,
          JSON.stringify(conversation),
        );
      }
      prune();
    },
    page: (id, beforeSequence = null) => {
      cleanup();
      const rows = db
        .prepare(
          'SELECT body FROM conversation_message_cache WHERE conversation_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 51',
        )
        .all(id, beforeSequence ?? Number.MAX_SAFE_INTEGER);
      const messages = rows
        .slice(0, 50)
        .map((row) => {
          const message = requireParsed(parseConversationMessage(body(row)));
          const retained = retainConversationMessage(message, clock.now());
          if (JSON.stringify(message) !== JSON.stringify(retained)) writeMessage(retained);
          return retained;
        })
        .reverse();
      return {
        messages,
        nextBeforeSequence: rows.length > 50 ? (messages[0]?.sequence ?? null) : null,
      };
    },
    completeRevision: (id) => {
      const row = db
        .prepare('SELECT revision FROM conversation_cache_completion WHERE id = ?')
        .get(id);
      return typeof row?.revision === 'number' ? row.revision : null;
    },
    markComplete: (conversation) => {
      if (metadata(conversation.conversationId)?.revision !== conversation.revision) return;
      const row = db
        .prepare(
          'SELECT COUNT(*) AS count, COUNT(DISTINCT sequence) AS sequences, MIN(sequence) AS first, MAX(sequence) AS last FROM conversation_message_cache WHERE conversation_id = ?',
        )
        .get(conversation.conversationId);
      if (
        row?.count !== conversation.lastSequence ||
        row.sequences !== conversation.lastSequence ||
        (conversation.lastSequence > 0 &&
          (row.first !== 1 || row.last !== conversation.lastSequence))
      )
        return;
      db.prepare('INSERT OR REPLACE INTO conversation_cache_completion VALUES (?, ?)').run(
        conversation.conversationId,
        conversation.revision,
      );
    },
    write: (conversation, messages) => {
      const parsed = requireParsed(parseConversation(conversation));
      if (
        messages.some(
          (message) =>
            message.conversationId !== parsed.conversationId ||
            message.sequence > parsed.lastSequence,
        )
      )
        throw new Error('CONVERSATION_CACHE_SCOPE_MISMATCH');
      const current = metadata(parsed.conversationId);
      if (current === null || current.revision > parsed.revision) return;
      db.prepare('INSERT OR REPLACE INTO conversation_cache VALUES (?, ?, ?)').run(
        parsed.conversationId,
        parsed.updatedAt,
        JSON.stringify(parsed),
      );
      for (const message of messages) writeMessage(message);
    },
  };
};
