import { initializeDurableCommitTable } from '@worker/adapters/out/persistence/thread/durable-commit-adapter';

export const initializeThreadStorage = (storage: DurableObjectStorage): void => {
  storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS thread_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            thread_id TEXT NOT NULL,
            owner_scope_ref TEXT NOT NULL,
            revision INTEGER NOT NULL,
            active INTEGER NOT NULL CHECK (active IN (0, 1)),
            state TEXT NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
          )
        `);
  storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS thread_operation (
            idempotency_key TEXT PRIMARY KEY,
            owner_scope_ref TEXT NOT NULL,
            action TEXT NOT NULL,
            turn_id TEXT,
            expected_revision INTEGER NOT NULL,
            result_revision INTEGER NOT NULL,
            result_active INTEGER NOT NULL CHECK (result_active IN (0, 1)),
            result_state TEXT NOT NULL
          )
        `);
  storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS runtime_turn (
            turn_id TEXT NOT NULL,
            owner_scope_ref TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            idempotency_key TEXT NOT NULL,
            input_digest TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('running', 'cancel_requested', 'cancelled', 'stale', 'completed', 'failed')),
            request_id TEXT,
            response_id TEXT,
            response_revision INTEGER,
            response_kind TEXT CHECK (response_kind IN ('message', 'cards')),
            response_presentation TEXT CHECK (response_presentation IN ('keep', 'replace')),
            response_card_set_id TEXT,
            PRIMARY KEY (thread_id, turn_id, revision),
            UNIQUE (idempotency_key)
          )
        `);
  initializeDurableCommitTable(storage);
};
