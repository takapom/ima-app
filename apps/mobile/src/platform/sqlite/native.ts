import * as SQLite from 'expo-sqlite';
import type { SQLiteOpenOptions } from 'expo-sqlite';
import { createSqliteStore } from '@mobile/platform/sqlite/store';
import type {
  SqliteConnection,
  SqliteStore,
  SqliteStoreOptions,
  SqliteValue,
} from '@mobile/platform/sqlite/types';

/** The synchronous subset used by the store; the concrete SDK stays in this adapter. */
export type NativeSqliteExecuteResult<T> = {
  readonly getFirstSync: () => T | null;
  readonly getAllSync: () => T[];
};

export type NativeSqliteStatement = {
  readonly executeSync: <T>(...values: SqliteValue[]) => NativeSqliteExecuteResult<T>;
  readonly finalizeSync: () => void;
};

export type NativeSqliteDatabase = {
  readonly closeSync: () => void;
  readonly execSync: (source: string) => void;
  readonly prepareSync: (source: string) => NativeSqliteStatement;
  readonly withTransactionSync: (task: () => void) => void;
};

export type NativeSqliteDriver = {
  readonly openDatabaseSync: (
    databaseName: string,
    options?: SQLiteOpenOptions,
    directory?: string,
  ) => NativeSqliteDatabase;
};

export type NativeSqliteAdapterOptions = SqliteStoreOptions & {
  /** An opaque, host-verified scope used verbatim as the Expo database name. */
  readonly storageScope: string;
  /** Injectable SDK boundary for tests and host-specific native composition. */
  readonly driver?: NativeSqliteDriver;
  readonly databaseOptions?: SQLiteOpenOptions;
  readonly directory?: string;
};

export type NativeSqliteAdapter = {
  readonly storageScope: string;
  /** Opens, migrates, and returns the same store until close. */
  readonly initialize: () => SqliteStore;
  /** Closes the active native handle; repeated calls are harmless. */
  readonly close: () => void;
  /** Returns null before initialization or after close. */
  readonly getStore: () => SqliteStore | null;
  readonly isInitialized: () => boolean;
};

const defaultDriver: NativeSqliteDriver = {
  openDatabaseSync: SQLite.openDatabaseSync,
};

// Keep enough room for the verified environment/origin namespace encoded by
// native composition while still rejecting path separators and SQL filename
// surprises. The host-provided scope itself is validated separately by the
// native credential authority contract.
const STORAGE_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/;

export const isValidStorageScope = (value: string): boolean =>
  typeof value === 'string' && STORAGE_SCOPE_PATTERN.test(value);

const assertStorageScope = (value: string): void => {
  if (!isValidStorageScope(value)) throw new Error('SQLITE_INVALID_STORAGE_SCOPE');
};

const connectionFor = (database: NativeSqliteDatabase): SqliteConnection => ({
  exec: (sql) => database.execSync(sql),
  prepare: (sql) => {
    const statement = database.prepareSync(sql);
    const execute = (values: SqliteValue[]): NativeSqliteExecuteResult<Record<string, unknown>> =>
      statement.executeSync<Record<string, unknown>>(...values);
    return {
      run: (...values) => {
        try {
          execute(values);
        } finally {
          statement.finalizeSync();
        }
      },
      get: (...values) => {
        try {
          return execute(values).getFirstSync() ?? undefined;
        } finally {
          statement.finalizeSync();
        }
      },
      all: (...values) => {
        try {
          return execute(values).getAllSync();
        } finally {
          statement.finalizeSync();
        }
      },
    };
  },
});

const transactionalStoreFor = (
  database: NativeSqliteDatabase,
  store: SqliteStore,
  isOpen: () => boolean,
): SqliteStore => {
  const transaction = <T>(operation: () => T): T => {
    if (!isOpen()) throw new Error('SQLITE_CLOSED');
    let outcome: { readonly value: T } | undefined;
    database.withTransactionSync(() => {
      outcome = { value: operation() };
    });
    if (outcome === undefined) throw new Error('SQLITE_TRANSACTION_NOT_COMPLETED');
    return outcome.value;
  };

  const cache = store.conversations;
  return {
    ...(cache === undefined
      ? {}
      : {
          conversations: {
            list: () => transaction(() => cache.list()),
            setRecent: (conversations) => transaction(() => cache.setRecent(conversations)),
            page: (id, before) => transaction(() => cache.page(id, before)),
            completeRevision: (id) => transaction(() => cache.completeRevision(id)),
            markComplete: (conversation) => transaction(() => cache.markComplete(conversation)),
            write: (conversation, messages) =>
              transaction(() => cache.write(conversation, messages)),
            remove: (id) => transaction(() => cache.remove(id)),
            cleanup: () => transaction(() => cache.cleanup()),
          },
        }),
    savePlace: (input) => transaction(() => store.savePlace(input)),
    listSavedPlaces: () => transaction(() => store.listSavedPlaces()),
    listTonightDecisions: () => transaction(() => store.listTonightDecisions()),
    setStarred: (localSavedEntryId, starred) =>
      transaction(() => store.setStarred(localSavedEntryId, starred)),
    markDecided: (localSavedEntryId, decidedAt) =>
      transaction(() =>
        decidedAt === undefined
          ? store.markDecided(localSavedEntryId)
          : store.markDecided(localSavedEntryId, decidedAt),
      ),
    deleteSavedPlace: (localSavedEntryId) =>
      transaction(() => store.deleteSavedPlace(localSavedEntryId)),
    saveSkipTonight: (candidateRef, expiresAt) =>
      transaction(() =>
        expiresAt === undefined
          ? store.saveSkipTonight(candidateRef)
          : store.saveSkipTonight(candidateRef, expiresAt),
      ),
    isSkippedTonight: (candidateRef) => transaction(() => store.isSkippedTonight(candidateRef)),
    saveThread: (input) => transaction(() => store.saveThread(input)),
    listThreads: () => transaction(() => store.listThreads()),
    appendTurn: (input) => transaction(() => store.appendTurn(input)),
    listTurns: (threadId) => transaction(() => store.listTurns(threadId)),
    writeSnapshot: (input) => transaction(() => store.writeSnapshot(input)),
    readSnapshot: (threadId) => transaction(() => store.readSnapshot(threadId)),
    savePreferences: (preferences) => transaction(() => store.savePreferences(preferences)),
    readPreferences: () => transaction(() => store.readPreferences()),
    cleanupExpired: () => transaction(() => store.cleanupExpired()),
  };
};

/**
 * Compose the synchronous Expo SQLite SDK with the SDK-neutral retention store.
 * `storageScope` must come from the host's verified owner/environment scope and is
 * deliberately never derived from credentials or other secret material.
 */
export const createNativeSqliteAdapter = (
  options: NativeSqliteAdapterOptions,
): NativeSqliteAdapter => {
  assertStorageScope(options.storageScope);
  const driver = options.driver ?? defaultDriver;
  let database: NativeSqliteDatabase | null = null;
  let store: SqliteStore | null = null;
  let opening = false;

  const isInitialized = (): boolean => store !== null;

  const initialize = (): SqliteStore => {
    if (store !== null) return store;
    if (opening) throw new Error('SQLITE_INITIALIZATION_REENTRANT');
    opening = true;
    try {
      const openOptions = { ...(options.databaseOptions ?? {}), useNewConnection: true };
      const opened =
        options.directory === undefined
          ? driver.openDatabaseSync(options.storageScope, openOptions)
          : driver.openDatabaseSync(options.storageScope, openOptions, options.directory);
      try {
        const rawStore = createSqliteStore(connectionFor(opened), options);
        const readyStore = transactionalStoreFor(opened, rawStore, () => database === opened);
        database = opened;
        store = readyStore;
        return readyStore;
      } catch (error) {
        try {
          opened.closeSync();
        } catch {
          // Preserve the initialization failure; the handle is no longer exposed.
        }
        throw error;
      }
    } finally {
      opening = false;
    }
  };

  const close = (): void => {
    const opened = database;
    database = null;
    store = null;
    if (opened === null) return;
    opened.closeSync();
  };

  return {
    storageScope: options.storageScope,
    initialize,
    close,
    getStore: () => store,
    isInitialized,
  };
};
