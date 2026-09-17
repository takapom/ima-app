import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  auditRetentionSurface,
  installRetentionWriteAudit,
  observeForbiddenValue,
  readRetentionWriteAudit,
  type RetentionSqlReader,
  type RetentionStorageReader,
} from '../support/retention-audit';
import type { ThreadRuntimeTarget, ThreadRuntimeTurnInput } from '@api/thread-runtime/admission';
import type { ProductionThreadDO } from './runtime-production-worker';

type ProductionTestEnv = Cloudflare.Env & {
  readonly PRODUCTION_THREADS: DurableObjectNamespace<ProductionThreadDO>;
};

const productionEnv = (): ProductionTestEnv => env as ProductionTestEnv;

const MARKERS = [
  'M16_ALARM_STORAGE_CANARY',
  'M16_LLM_INPUT_CANARY',
  'M16_DENIED_FIELD_CANARY',
] as const;

// These rows either participate in CAS row-count checks or are SQLite FTS virtual tables.
// They remain in the read-only inventory below; they are explicitly outside the fixture-only
// BEFORE trigger surface so the audit cannot change production transaction semantics.
const BEFORE_WRITE_EXCLUSIONS = new Set([
  'thread_state',
  'runtime_turn',
  'assistant_fts',
  'assistant_fts_data',
  'assistant_fts_idx',
  'assistant_fts_content',
  'assistant_fts_docsize',
  'assistant_fts_config',
]);

const requestFor = (target: ThreadRuntimeTarget): ThreadRuntimeTurnInput => ({
  ...target,
  idempotencyKey: `m16-retention-audit-${target.turnId}`,
  input: {
    schemaVersion: 'v1',
    requestId: `request-${target.turnId}`,
    turnId: target.turnId,
    revision: target.revision,
    text: 'M16_ALARM_STORAGE_CANARY を含む静かなカフェを探して',
    clientNow: '2026-09-10T12:00:00.000Z',
    location: {
      status: 'unavailable',
      lat: null,
      lng: null,
      accuracyMeters: null,
      precise: false,
      capturedAt: null,
    },
    prefs: {
      homeStationRef: null,
      maxWalkMinutes: null,
      minimumStayMinutes: null,
      areaText: '現在地周辺',
      budget: 'normal',
    },
    savedPlaceRefs: [],
    excludeCandidateIds: [],
    mode: 'search',
    idempotencyKey: `m16-retention-audit-${target.turnId}`,
  },
});

type ForbiddenLocation = {
  readonly table: string;
  readonly columns: readonly string[];
};

const readTableNames = (state: DurableObjectState): readonly string[] =>
  state.storage.sql
    .exec<{ readonly name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .toArray()
    .map((row) => row.name);

const beforeWriteAuditSql = (sql: RetentionSqlReader): RetentionSqlReader => ({
  exec(query, ...bindings) {
    const result = sql.exec(query, ...bindings);
    if (!query.includes("FROM sqlite_master WHERE type = 'table'")) return result;
    return {
      toArray: () =>
        result.toArray().filter((row) => {
          const tableName = row.name;
          return typeof tableName !== 'string' || !BEFORE_WRITE_EXCLUSIONS.has(tableName);
        }),
    };
  },
});

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const forbiddenLocations = (
  state: DurableObjectState,
  markers: readonly string[],
): readonly ForbiddenLocation[] => {
  const locations: ForbiddenLocation[] = [];
  for (const table of readTableNames(state)) {
    let rows: readonly Record<string, unknown>[];
    try {
      rows = state.storage.sql.exec(`SELECT * FROM ${quoteIdentifier(table)}`).toArray();
    } catch {
      continue;
    }
    for (const row of rows) {
      const columns = Object.entries(row)
        .filter(([, value]) => observeForbiddenValue(value, markers).hasForbidden)
        .map(([column]) => column);
      if (columns.length > 0) locations.push({ table, columns });
    }
  }
  return locations;
};

const forbiddenWriteLocations = (state: DurableObjectState): readonly string[] =>
  state.storage.sql
    .exec<{ readonly table_name: string; readonly operation: string }>(
      'SELECT DISTINCT table_name, operation FROM retention_write_audit WHERE saw_forbidden = 1 ORDER BY table_name, operation',
    )
    .toArray()
    .map((row) => `${row.table_name}:${row.operation}`);

const storageReader = (state: DurableObjectState): RetentionStorageReader => ({
  list: () => state.storage.list(),
  get: <T>(key: string) => state.storage.get<T>(key),
});

const installAudit = (stub: DurableObjectStub<ProductionThreadDO>) =>
  runInDurableObject(stub, (_instance, state) =>
    installRetentionWriteAudit(beforeWriteAuditSql(state.storage.sql), MARKERS),
  );

const expectCleanAudit = async (stub: DurableObjectStub<ProductionThreadDO>): Promise<void> => {
  const audit = await runInDurableObject(stub, (_instance, state) => {
    const write = readRetentionWriteAudit(state.storage.sql);
    const locations = forbiddenLocations(state, MARKERS);
    const forbiddenWrites = forbiddenWriteLocations(state);
    return { write, locations, forbiddenWrites, tables: readTableNames(state) };
  });
  expect(audit.write.observed).toBe(true);
  expect(audit.write.readErrors).toBe(0);
  expect(audit.write.forbiddenWrites).toBe(0);
  expect(audit.forbiddenWrites).toEqual([]);
  expect(audit.locations).toEqual([]);
  for (const table of BEFORE_WRITE_EXCLUSIONS) expect(audit.tables).toContain(table);

  const surfaces = await runInDurableObject(stub, async (instance, state) =>
    auditRetentionSurface(
      {
        messages: instance.messages,
        storage: storageReader(state),
        sql: state.storage.sql,
      },
      MARKERS,
    ),
  );
  expect(surfaces.messages.forbiddenEntries).toBe(0);
  expect(surfaces.storage.readErrors).toBe(0);
  expect(surfaces.storage.forbiddenEntries).toBe(0);
  expect(surfaces.sql.readErrors).toBe(0);
  expect(surfaces.sql.tables.every((table) => table.forbiddenRows === 0)).toBe(true);
  expect(surfaces.sql.unobservedTables).toEqual([
    { tableName: '_cf_KV', status: 'platform-owned', reason: 'not-publicly-readable' },
    { tableName: '_cf_METADATA', status: 'platform-owned', reason: 'not-publicly-readable' },
  ]);
};

describe('M16 production retention write audit', () => {
  it('installs before-write audit before the real Think/DO turn and inventories public surfaces', async () => {
    const threadId = `m16-retention-audit-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: `owner-${crypto.randomUUID()}`,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);
    await stub.configureRuntimeScenario('llm-only');
    await expect(stub.initialize(target.ownerScopeRef, threadId)).resolves.toMatchObject({
      ok: true,
    });

    const installation = await installAudit(stub);
    expect(installation.observed).toBe(true);
    expect(installation.readErrors).toBe(0);
    expect(installation.installErrors).toBe(0);
    const result = await stub.runRuntimeTurn({
      ...requestFor(target),
      input: {
        ...requestFor(target).input,
        text: '[m16-llm-only] M16_ALARM_STORAGE_CANARY を含む静かなカフェを探して',
      },
    });
    expect(result.status).toBe('completed');

    await expectCleanAudit(stub);
  });

  it('keeps forbidden payloads out of every observed surface on a typed failed turn', async () => {
    const threadId = `m16-retention-audit-failed-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: `owner-${crypto.randomUUID()}`,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);
    await stub.configureRuntimeScenario('llm-only');
    await expect(stub.initialize(target.ownerScopeRef, threadId)).resolves.toMatchObject({
      ok: true,
    });
    const installation = await installAudit(stub);
    expect(installation).toMatchObject({ observed: true, readErrors: 0, installErrors: 0 });

    await expect(
      stub.runRuntimeTurn({
        ...requestFor(target),
        input: {
          ...requestFor(target).input,
          text: '[m16-llm-only] [m16-late-tool] M16_ALARM_STORAGE_CANARY を保存しない',
        },
      }),
    ).resolves.toMatchObject({ status: 'failed', code: 'RUNTIME_FAILED' });
    await expectCleanAudit(stub);
  });
});
