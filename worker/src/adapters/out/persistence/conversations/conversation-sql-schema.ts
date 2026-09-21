import type { ConversationStoreFailure } from '@worker/application/ports/conversation-store';

export type ConversationSqlStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;
export type JsonRow = { readonly body: string };
export const storeFailure = (code: ConversationStoreFailure['code']): ConversationStoreFailure => ({
  ok: false,
  code,
});

export const initializeConversationStorage = (storage: ConversationSqlStorage): void => {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      owner TEXT NOT NULL, id TEXT NOT NULL, body TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY (owner, id)
    );
    CREATE INDEX IF NOT EXISTS conversation_listing ON conversations (owner, updated_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS conversation_messages (
      owner TEXT NOT NULL, conversation_id TEXT NOT NULL, id TEXT NOT NULL,
      sequence INTEGER NOT NULL, body TEXT NOT NULL, expires_at REAL,
      PRIMARY KEY (owner, conversation_id, id), UNIQUE (owner, conversation_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS conversation_message_expiry ON conversation_messages (expires_at);
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      owner TEXT NOT NULL, conversation_id TEXT NOT NULL, through_sequence INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(owner, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_operations (
      owner TEXT NOT NULL, conversation_id TEXT NOT NULL, key TEXT NOT NULL,
      fingerprint TEXT NOT NULL, message_id TEXT, revision INTEGER NOT NULL,
      PRIMARY KEY (owner, conversation_id, key)
    );
    CREATE TABLE IF NOT EXISTS conversation_creations (
      owner TEXT NOT NULL, key TEXT NOT NULL, conversation_id TEXT NOT NULL,
      PRIMARY KEY (owner, key)
    );
    CREATE TABLE IF NOT EXISTS conversation_runs (
      owner TEXT NOT NULL, conversation_id TEXT NOT NULL, id TEXT NOT NULL,
      key TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL,
      pending INTEGER NOT NULL, PRIMARY KEY (owner, conversation_id, id),
      UNIQUE (owner, conversation_id, key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_conversation_run
      ON conversation_runs(owner, conversation_id) WHERE pending = 1;
  `);
};
