import { env, runInDurableObject } from 'cloudflare:test';
import { ThreadTurnRequestSchema, type ThreadTurnRequest } from '@ima/contracts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { observeForbiddenValue } from '../support/retention-audit';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
} from '@worker/infrastructure/runtime/threads/admission';
import type { ProductionThreadDO } from './runtime-production-worker';

type ProductionTestEnv = Cloudflare.Env & {
  readonly PRODUCTION_THREADS: DurableObjectNamespace<ProductionThreadDO>;
};

const productionEnv = (): ProductionTestEnv => env as ProductionTestEnv;

const PLATFORM_OWNED_TABLES = ['_cf_KV', '_cf_METADATA'] as const;
const platformOwnedTables = new Set<string>(PLATFORM_OWNED_TABLES);
const PROVIDER_MARKERS = ['M16_LLM_INPUT_CANARY', 'M16_DENIED_FIELD_CANARY'] as const;

const requestFor = (target: ThreadRuntimeTarget): ThreadRuntimeTurnInput => {
  const idempotencyKey = `m24-storage-${target.turnId}`;
  const input = {
    schemaVersion: 'v1',
    requestId: `request-${target.turnId}`,
    turnId: target.turnId,
    revision: target.revision,
    text: 'M24_USER_SENTINEL の条件で静かなカフェを探して',
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
      areaText: '保存面監査',
      budget: 'normal',
    },
    savedPlaceRefs: [],
    excludeCandidateIds: [],
    mode: 'search',
    idempotencyKey,
  } satisfies ThreadTurnRequest;
  const parsed = v.parse(ThreadTurnRequestSchema, input);
  return { ...target, idempotencyKey, input: parsed };
};

type StorageAudit = {
  readonly tables: readonly string[];
  readonly sqlReadable: Readonly<Record<string, boolean>>;
  readonly sqlProviderMarkerRows: number;
  readonly publicStorageKeys: readonly string[];
  readonly publicStorageReadErrors: number;
  readonly publicStorageProviderMarkers: number;
  readonly sdkMessageProviderMarkers: number;
  readonly domains: {
    readonly hostContextRows: number;
    readonly rawMessageRows: number;
    readonly checkpointRows: number;
  };
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const countProviderMarkers = (value: unknown): number =>
  observeForbiddenValue(value, PROVIDER_MARKERS).markerMatches;

const countRows = (state: DurableObjectState, table: string): number => {
  const row = state.storage.sql
    .exec<{ readonly count: number }>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`)
    .toArray()[0];
  return typeof row?.count === 'number' ? row.count : 0;
};

const inspectPublicStorage = async (
  instance: ProductionThreadDO,
  state: DurableObjectState,
): Promise<StorageAudit> => {
  const tables = state.storage.sql
    .exec<{ readonly name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .toArray()
    .flatMap((row) => (typeof row.name === 'string' ? [row.name] : []));
  const sqlReadable: Record<string, boolean> = {};
  let sqlProviderMarkerRows = 0;
  for (const table of tables) {
    try {
      const rows = state.storage.sql.exec(`SELECT * FROM ${quoteIdentifier(table)}`).toArray();
      sqlReadable[table] = true;
      sqlProviderMarkerRows += rows.filter((row) => countProviderMarkers(row) > 0).length;
    } catch {
      sqlReadable[table] = false;
    }
  }

  const listed = await state.storage.list();
  let publicStorageReadErrors = 0;
  let publicStorageProviderMarkers = 0;
  for (const [key, value] of listed) {
    publicStorageProviderMarkers += countProviderMarkers(key) + countProviderMarkers(value);
    try {
      publicStorageProviderMarkers += countProviderMarkers(await state.storage.get(key));
    } catch {
      publicStorageReadErrors += 1;
    }
  }
  const sdkMessageProviderMarkers = instance.messages.reduce(
    (count, message) => count + countProviderMarkers(message),
    0,
  );
  return {
    tables,
    sqlReadable,
    sqlProviderMarkerRows,
    publicStorageKeys: [...listed.keys()],
    publicStorageReadErrors,
    publicStorageProviderMarkers,
    sdkMessageProviderMarkers,
    domains: {
      hostContextRows: countRows(state, 'runtime_context_reference'),
      rawMessageRows: countRows(state, 'assistant_messages'),
      checkpointRows: countRows(state, 'runtime_commit') + countRows(state, 'runtime_turn'),
    },
  };
};

describe('M23 real DO public storage inventory', () => {
  it('observes four public domains and distinguishes platform-owned tables from zero rows', async () => {
    const threadId = `m24-storage-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: `owner-${crypto.randomUUID()}`,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);
    await expect(stub.initialize(target.ownerScopeRef, threadId)).resolves.toMatchObject({
      ok: true,
    });
    await expect(stub.runRuntimeTurn(requestFor(target))).resolves.toMatchObject({
      status: 'completed',
    });

    const audit = await runInDurableObject(stub, (instance, state) =>
      inspectPublicStorage(instance, state),
    );
    expect(audit.tables).toEqual(expect.arrayContaining([...PLATFORM_OWNED_TABLES]));
    for (const table of PLATFORM_OWNED_TABLES) expect(audit.sqlReadable[table]).toBe(false);
    expect(
      audit.tables
        .filter((table) => !platformOwnedTables.has(table))
        .every((table) => audit.sqlReadable[table] === true),
    ).toBe(true);
    expect(audit.publicStorageKeys).not.toEqual(expect.arrayContaining([...PLATFORM_OWNED_TABLES]));
    expect(audit.publicStorageReadErrors).toBe(0);
    expect(audit.sqlProviderMarkerRows).toBe(0);
    expect(audit.publicStorageProviderMarkers).toBe(0);
    expect(audit.sdkMessageProviderMarkers).toBe(0);
    expect(audit.domains.hostContextRows).toBeGreaterThan(0);
    expect(audit.domains.rawMessageRows).toBeGreaterThan(0);
    expect(audit.domains.checkpointRows).toBeGreaterThan(0);
  });
});
