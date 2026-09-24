import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RetentionMetadata } from '@ima/contracts';
import type { AssistantResponseState } from '@mobile/journey/state/assistant-response';
import { createAssistantResponseState } from '@mobile/journey/state/assistant-response';
import {
  createLocalSessionPersistence,
  createSqliteJourneyLocalRestore,
} from '@mobile/journey/services/thread-session/local-session-persistence';
import { createSqliteStore } from '@mobile/platform/sqlite/store';
import type {
  LocalSavedEntryId,
  SqliteConnection,
  SqliteStore,
  SqliteValue,
} from '@mobile/platform/sqlite/types';

const nowValue = '2026-09-10T12:00:00.000Z';
const sessionExpiresAt = '2026-09-10T13:00:00.000Z';
const asLocal = (value: string): LocalSavedEntryId => value as LocalSavedEntryId;
const retention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt,
  freshUntil: '2026-09-10T12:30:00.000Z',
  displayUntil: sessionExpiresAt,
  retentionUntil: sessionExpiresAt,
  deletionScheduledAt: sessionExpiresAt,
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};
const shorterRetention: RetentionMetadata = {
  ...retention,
  sessionExpiresAt: '2026-09-10T12:45:00.000Z',
  freshUntil: '2026-09-10T12:15:00.000Z',
  displayUntil: '2026-09-10T12:40:00.000Z',
  retentionUntil: '2026-09-10T12:40:00.000Z',
  deletionScheduledAt: '2026-09-10T12:40:00.000Z',
};

type FakeController = {
  state: ReturnType<typeof createAssistantResponseState>;
  readonly emit: () => void;
  readonly controller: {
    readonly getState: () => {
      readonly mode: 'fixture';
      readonly threadId: string | null;
      readonly responseState: AssistantResponseState | null;
      readonly localSnapshot: null;
      readonly activeTurnId: null;
      readonly status: 'idle';
      readonly error: null;
      readonly lastRequestId: null;
    };
    readonly subscribe: (listener: () => void) => () => void;
  };
};

const stateWithResponse = (
  revision = 1,
  overrides: Partial<RetentionMetadata> = {},
): AssistantResponseState => ({
  ...createAssistantResponseState('thread-1'),
  revision,
  appliedResponseIds: [`response-${revision}`],
  responseRecords: [
    {
      responseId: `response-${revision}`,
      turnId: `turn-${revision}`,
      revision,
      kind: 'message',
      presentation: 'keep',
      declaredCardSetId: null,
      effectiveCardSetId: null,
      messages: [
        {
          text: 'モデル本文 PRIVATE_MODEL_TEXT',
          retention: { ...retention, ...overrides },
        },
      ],
    },
  ],
  cardSetDisplay: { kind: 'empty', reason: 'no_cards', responseId: `response-${revision}` },
});

const createController = (state: AssistantResponseState): FakeController => {
  let currentState = state;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const controller = {
    getState: () => ({
      mode: 'fixture' as const,
      threadId: currentState.threadId,
      responseState: currentState,
      localSnapshot: null,
      activeTurnId: null,
      status: 'idle' as const,
      error: null,
      lastRequestId: null,
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    get state() {
      return currentState;
    },
    set state(next: AssistantResponseState) {
      currentState = next;
    },
    emit,
    controller,
  };
};

type OpenedDatabase = { readonly raw: DatabaseSync; readonly store: SqliteStore };

const openStore = (clock: () => string): OpenedDatabase => {
  const raw = new DatabaseSync(':memory:');
  const connection: SqliteConnection = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      return {
        run: (...values: SqliteValue[]) => statement.run(...values),
        get: (...values: SqliteValue[]) => statement.get(...values),
        all: (...values: SqliteValue[]) =>
          statement.all(...values).map((row) => row as Record<string, unknown>),
      };
    },
  };
  return {
    raw,
    store: createSqliteStore(connection, {
      clock: { now: clock },
      nextLocalSavedEntryId: () => asLocal('local-1'),
    }),
  };
};

describe('local session persistence', () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('stores only current response references and the shortest future retention bounds', () => {
    const opened = openStore(() => nowValue);
    databases.push(opened.raw);
    // The Worker bounds generated text by what the model was shown; the snapshot keeps it.
    const controller = createController(stateWithResponse(1, shorterRetention));
    const persistence = createLocalSessionPersistence({
      controller: controller.controller,
      store: opened.store,
      now: () => nowValue,
    });

    expect(opened.store.readSnapshot('thread-1')).toEqual({
      threadId: 'thread-1',
      responseId: 'response-1',
      revision: 1,
      response: null,
      restoreMode: 'reference_only',
      updatedAt: nowValue,
      sessionExpiresAt: '2026-09-10T12:45:00.000Z',
      displayUntil: '2026-09-10T12:40:00.000Z',
      retentionUntil: '2026-09-10T12:40:00.000Z',
      deletionScheduledAt: '2026-09-10T12:40:00.000Z',
      needsRefetch: true,
    });
    const stored = JSON.stringify({
      snapshots: opened.raw.prepare('SELECT * FROM thread_snapshot').all(),
      threads: opened.raw.prepare('SELECT * FROM thread').all(),
    });
    expect(stored).not.toContain('PRIVATE_MODEL_TEXT');
    expect(stored).not.toContain('query');
    persistence.dispose();
  });

  it.each([
    ['policy denied', { retentionDecision: 'deny' as const }],
    ['policy unavailable', { policyStatus: 'policy_withheld' as const }],
    ['display unavailable', { displayPolicyStatus: 'expired' as const }],
    ['freshness expired', { freshUntil: nowValue }],
    ['session expired', { sessionExpiresAt: nowValue }],
  ])('does not persist when %s', (_label, overrides) => {
    const opened = openStore(() => nowValue);
    databases.push(opened.raw);
    const controller = createController(stateWithResponse(1, overrides));
    const saveThread = vi.spyOn(opened.store, 'saveThread');
    const writeSnapshot = vi.spyOn(opened.store, 'writeSnapshot');
    const persistence = createLocalSessionPersistence({
      controller: controller.controller,
      store: opened.store,
      now: () => nowValue,
    });

    expect(saveThread).not.toHaveBeenCalled();
    expect(writeSnapshot).not.toHaveBeenCalled();
    expect(opened.store.readSnapshot('thread-1')).toBeNull();
    persistence.dispose();
  });

  it('anchors the first local observation and never extends the thread on later revisions', () => {
    const opened = openStore(() => nowValue);
    databases.push(opened.raw);
    const controller = createController(stateWithResponse());
    const saveThread = vi.spyOn(opened.store, 'saveThread');
    const persistence = createLocalSessionPersistence({
      controller: controller.controller,
      store: opened.store,
      now: () => nowValue,
    });
    expect(saveThread).toHaveBeenCalledTimes(1);
    expect(saveThread).toHaveBeenCalledWith({
      id: 'thread-1',
      createdAt: nowValue,
      expiresAt: sessionExpiresAt,
    });
    controller.state = stateWithResponse(2, {
      sessionExpiresAt: '2026-09-10T15:00:00.000Z',
      freshUntil: '2026-09-10T14:00:00.000Z',
      displayUntil: '2026-09-10T15:00:00.000Z',
      retentionUntil: '2026-09-10T15:00:00.000Z',
      deletionScheduledAt: '2026-09-10T15:00:00.000Z',
    });
    controller.emit();
    expect(
      opened.raw.prepare('SELECT expires_at FROM thread WHERE id = ?').get('thread-1'),
    ).toEqual({ expires_at: '2026-09-10T13:00:00.000Z' });
    persistence.dispose();
  });

  it('keeps the first observation when the response arrives later', () => {
    let currentNow = '2026-09-10T11:30:00.000Z';
    const opened = openStore(() => currentNow);
    databases.push(opened.raw);
    const controller = createController(createAssistantResponseState('thread-1'));
    const saveThread = vi.spyOn(opened.store, 'saveThread');
    const persistence = createLocalSessionPersistence({
      controller: controller.controller,
      store: opened.store,
      now: () => currentNow,
    });

    currentNow = nowValue;
    controller.state = stateWithResponse();
    controller.emit();

    expect(saveThread).toHaveBeenCalledWith({
      id: 'thread-1',
      createdAt: '2026-09-10T11:30:00.000Z',
      expiresAt: sessionExpiresAt,
    });
    persistence.dispose();
  });

  it('does not extend a thread when the local 05:00 JST window changes', () => {
    let currentNow = '2026-09-10T19:30:00.000Z';
    const opened = openStore(() => currentNow);
    databases.push(opened.raw);
    const controller = createController(createAssistantResponseState('thread-1'));
    const persistence = createLocalSessionPersistence({
      controller: controller.controller,
      store: opened.store,
      now: () => currentNow,
    });
    const beforeCutoff = {
      sessionExpiresAt: '2026-09-10T20:00:00.000Z',
      freshUntil: '2026-09-10T19:55:00.000Z',
      displayUntil: '2026-09-10T20:00:00.000Z',
      retentionUntil: '2026-09-10T20:00:00.000Z',
      deletionScheduledAt: '2026-09-10T20:00:00.000Z',
    };

    currentNow = '2026-09-10T19:45:00.000Z';
    controller.state = stateWithResponse(1, beforeCutoff);
    controller.emit();
    expect(
      opened.raw.prepare('SELECT created_at, expires_at FROM thread WHERE id = ?').get('thread-1'),
    ).toEqual({
      created_at: '2026-09-10T19:30:00.000Z',
      expires_at: '2026-09-10T20:00:00.000Z',
    });

    currentNow = '2026-09-10T20:01:00.000Z';
    controller.state = stateWithResponse(2, beforeCutoff);
    controller.emit();
    expect(
      opened.raw.prepare('SELECT created_at, expires_at FROM thread WHERE id = ?').get('thread-1'),
    ).toEqual({
      created_at: '2026-09-10T19:30:00.000Z',
      expires_at: '2026-09-10T20:00:00.000Z',
    });
    persistence.dispose();
  });

  it('retries a revision after the store reports that it was not written', () => {
    const opened = openStore(() => nowValue);
    databases.push(opened.raw);
    opened.store.saveThread({
      id: 'thread-1',
      createdAt: '2026-09-10T11:30:00.000Z',
      expiresAt: sessionExpiresAt,
    });
    opened.store.writeSnapshot({
      threadId: 'thread-1',
      responseId: 'response-2',
      revision: 2,
      sessionExpiresAt,
      displayUntil: sessionExpiresAt,
      retentionUntil: sessionExpiresAt,
      deletionScheduledAt: sessionExpiresAt,
    });
    const controller = createController(stateWithResponse(1));
    const writeSnapshot = vi.spyOn(opened.store, 'writeSnapshot');
    const persistence = createLocalSessionPersistence({
      controller: controller.controller,
      store: opened.store,
      now: () => nowValue,
    });

    expect(writeSnapshot).toHaveBeenCalledTimes(1);
    controller.emit();
    expect(writeSnapshot).toHaveBeenCalledTimes(2);
    persistence.dispose();
  });

  it('suppresses old revisions, ignores late events after dispose, and isolates closed-store failures', () => {
    const opened = openStore(() => nowValue);
    databases.push(opened.raw);
    const controller = createController(stateWithResponse(2));
    const writeSnapshot = vi.spyOn(opened.store, 'writeSnapshot');
    const persistence = createLocalSessionPersistence({
      controller: controller.controller,
      store: opened.store,
      now: () => nowValue,
    });
    expect(writeSnapshot).toHaveBeenCalledTimes(1);
    controller.state = stateWithResponse(1);
    controller.emit();
    expect(writeSnapshot).toHaveBeenCalledTimes(1);
    persistence.dispose();
    controller.state = stateWithResponse(3);
    expect(() => controller.emit()).not.toThrow();
    expect(writeSnapshot).toHaveBeenCalledTimes(1);

    const closedController = createController(stateWithResponse(4));
    const closedPersistence = createLocalSessionPersistence({
      controller: closedController.controller,
      store: opened.store,
      now: () => nowValue,
    });
    const databaseIndex = databases.indexOf(opened.raw);
    if (databaseIndex >= 0) databases.splice(databaseIndex, 1);
    opened.raw.close();
    closedController.state = stateWithResponse(5);
    expect(() => closedController.emit()).not.toThrow();
    closedPersistence.dispose();
  });

  it('passes the same store to the metadata-only local restore port', () => {
    const opened = openStore(() => nowValue);
    databases.push(opened.raw);
    opened.store.saveThread({
      id: 'thread-1',
      createdAt: '2026-09-10T11:30:00.000Z',
      expiresAt: sessionExpiresAt,
    });
    opened.store.writeSnapshot({
      threadId: 'thread-1',
      responseId: 'response-1',
      revision: 1,
      sessionExpiresAt,
      displayUntil: sessionExpiresAt,
      retentionUntil: sessionExpiresAt,
      deletionScheduledAt: sessionExpiresAt,
    });
    const restore = createSqliteJourneyLocalRestore(opened.store);
    expect(restore.readSnapshot('thread-1')).toMatchObject({
      threadId: 'thread-1',
      responseId: 'response-1',
      revision: 1,
      response: null,
      restoreMode: 'reference_only',
    });
  });
});
