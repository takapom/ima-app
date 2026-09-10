import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
} from '../../src/thread-runtime/admission';
import {
  createRuntimeRetentionAlarmCapability,
  RUNTIME_RETENTION_ALARM_TABLE,
} from '../../src/thread-runtime/runtime-retention-alarm';
import type { ProductionThreadDO } from './runtime-production-worker';

type ProductionTestEnv = Cloudflare.Env & {
  readonly PRODUCTION_THREADS: DurableObjectNamespace<ProductionThreadDO>;
};

const productionEnv = (): ProductionTestEnv => env as ProductionTestEnv;

const requestFor = (
  target: ThreadRuntimeTarget,
  text = 'M16_ALARM_STORAGE_CANARY を含む静かなカフェを探して',
): ThreadRuntimeTurnInput => ({
  ...target,
  idempotencyKey: `m16-alarm-${target.turnId}`,
  input: {
    schemaVersion: 'v1',
    requestId: `request-${target.turnId}`,
    turnId: target.turnId,
    revision: target.revision,
    text,
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
    idempotencyKey: `m16-alarm-${target.turnId}`,
  },
});

const setAnchor = (stub: DurableObjectStub<ProductionThreadDO>, value: string) =>
  runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      'UPDATE runtime_retention_anchor SET thread_created_at = ? WHERE singleton = 1',
      value,
    );
  });

const containsCanary = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value === 'string') return value.includes('M16_ALARM_STORAGE_CANARY');
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsCanary(item, seen));
  return Object.values(value).some((item) => containsCanary(item, seen));
};

const storageCanaryState = (stub: DurableObjectStub<ProductionThreadDO>) =>
  runInDurableObject(stub, async (_instance, state) => {
    const tables = state.storage.sql
      .exec<{ readonly name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .toArray();
    let sqlCanary = false;
    const unobservedSqlTables: string[] = [];
    for (const table of tables) {
      const identifier = table.name.replaceAll('"', '""');
      try {
        const rows = state.storage.sql.exec(`SELECT * FROM "${identifier}"`);
        if (rows.toArray().some((row) => containsCanary(row))) sqlCanary = true;
      } catch {
        unobservedSqlTables.push(table.name);
      }
    }
    let storageCanary = false;
    try {
      for (const [key, value] of await state.storage.list()) {
        if (containsCanary(key) || containsCanary(value)) storageCanary = true;
      }
    } catch {
      storageCanary = true;
    }
    return {
      sqlCanary,
      storageCanary,
      observedSqlTables: tables.map((table) => table.name),
      unobservedSqlTables,
    };
  });

const expectObservedSurfacesClean = async (stub: DurableObjectStub<ProductionThreadDO>) => {
  const state = await storageCanaryState(stub);
  expect(state.sqlCanary).toBe(false);
  expect(state.storageCanary).toBe(false);
  // _cf_* is platform-owned and rejects public SQL reads; the fixture does not treat it as zero.
  expect(state.unobservedSqlTables.every((name) => name.startsWith('_cf_'))).toBe(true);
};

describe('M16 retention alarm capability', () => {
  it('arms from initialize through public Lifecycle without replacing Think alarms', async () => {
    const threadId = `m16-alarm-arm-${crypto.randomUUID()}`;
    const ownerScopeRef = `m16-alarm-owner-${crypto.randomUUID()}`;
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);
    await setAnchor(stub, '2026-09-10T19:59:00.000Z');
    await expect(stub.initialize(ownerScopeRef, threadId)).resolves.toMatchObject({ ok: true });
    await expect(
      runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBe(Date.parse('2026-09-10T20:00:00.000Z'));
  });

  it('cleans runtime state at the fixed expiry and records bounded alarm delay', async () => {
    const threadId = `m16-alarm-clean-${crypto.randomUUID()}`;
    const ownerScopeRef = `m16-alarm-owner-${crypto.randomUUID()}`;
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);
    await setAnchor(stub, '2026-09-10T19:59:00.000Z');
    await expect(stub.initialize(ownerScopeRef, threadId)).resolves.toMatchObject({ ok: true });
    const target: ThreadRuntimeTarget = {
      ownerScopeRef,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const result = await stub.runRuntimeTurn(requestFor(target));
    if (result.status !== 'completed') throw new Error(JSON.stringify(result));
    // The production fixture intentionally uses an allow/full retention policy. The user text
    // therefore exists before the fixed expiry in assistant_messages.content (and the SDK FTS
    // projection); the expiry assertion below is the deletion boundary.
    const beforeAlarm = await storageCanaryState(stub);
    expect(beforeAlarm.sqlCanary).toBe(true);
    expect(beforeAlarm.storageCanary).toBe(false);

    const afterAlarm = await runInDurableObject(stub, async (instance, state) => {
      instance.setRuntimeProductionNow('2026-09-10T20:05:00.000Z');
      await instance.alarm();
      return {
        alarm: await state.storage.getAlarm(),
        retention: state.storage.sql
          .exec<{
            readonly completed_at: string | null;
            readonly delay_ms: number | null;
          }>(
            `SELECT completed_at, delay_ms FROM ${RUNTIME_RETENTION_ALARM_TABLE} WHERE singleton = 1`,
          )
          .toArray()[0],
        runtimeRows: {
          context: state.storage.sql
            .exec<{ readonly count: number }>(
              'SELECT COUNT(*) AS count FROM runtime_context_reference',
            )
            .toArray()[0]?.count,
          commits: state.storage.sql
            .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM runtime_commit')
            .toArray()[0]?.count,
          messages: state.storage.sql
            .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM assistant_messages')
            .toArray()[0]?.count,
        },
      };
    });
    expect(afterAlarm.alarm).toEqual(expect.any(Number));
    expect(afterAlarm.retention?.completed_at).toEqual('2026-09-10T20:05:00.000Z');
    expect(afterAlarm.retention?.delay_ms).toBe(5 * 60 * 1_000);
    expect(afterAlarm.runtimeRows).toEqual({ context: 0, commits: 0, messages: 0 });
    await expectObservedSurfacesClean(stub);
  });

  it('fails closed with a durable bounded retry marker for an invalid anchor', async () => {
    const threadId = `m16-alarm-invalid-${crypto.randomUUID()}`;
    const ownerScopeRef = `m16-alarm-owner-${crypto.randomUUID()}`;
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);
    await setAnchor(stub, 'not-an-iso-timestamp');
    await evictDurableObject(stub);
    const reopened = productionEnv().PRODUCTION_THREADS.getByName(threadId);
    await expect(reopened.initialize(ownerScopeRef, threadId)).resolves.toMatchObject({ ok: true });
    const retryState = await runInDurableObject(reopened, async (instance, state) => {
      await instance.alarm();
      return {
        row: state.storage.sql
          .exec<{
            readonly completed_at: string | null;
            readonly failure_count: number;
            readonly retry_at: string | null;
          }>(
            `SELECT completed_at, failure_count, retry_at FROM ${RUNTIME_RETENTION_ALARM_TABLE} WHERE singleton = 1`,
          )
          .toArray()[0],
        alarm: await state.storage.getAlarm(),
      };
    });
    expect(retryState.row).toMatchObject({
      completed_at: null,
      failure_count: 1,
    });
    expect(retryState.row?.retry_at).toEqual(expect.any(String));
    expect(retryState.alarm).toEqual(expect.any(Number));
    await expectObservedSurfacesClean(reopened);
  });

  it('records a bounded retry when the cleanup capability throws', async () => {
    const threadId = `m16-alarm-on-due-error-${crypto.randomUUID()}`;
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);
    const state = await runInDurableObject(stub, async (_instance, durableState) => {
      let rearmed = false;
      const capability = createRuntimeRetentionAlarmCapability({
        storage: durableState.storage,
        now: () => '2026-09-10T20:05:00.000Z',
        expiryAt: () => '2026-09-10T20:00:00.000Z',
        onDue: () => Promise.reject(new Error('fixture cleanup failure')),
        rearm: () => {
          rearmed = true;
          return Promise.resolve();
        },
      });
      await capability.onAlarm?.();
      return {
        rearmed,
        row: durableState.storage.sql
          .exec<{
            readonly failure_count: number;
            readonly retry_at: string | null;
            readonly completed_at: string | null;
          }>(
            `SELECT failure_count, retry_at, completed_at FROM ${RUNTIME_RETENTION_ALARM_TABLE} WHERE singleton = 1`,
          )
          .toArray()[0],
      };
    });
    expect(state.rearmed).toBe(true);
    expect(state.row).toMatchObject({ failure_count: 1, completed_at: null });
    expect(state.row?.retry_at).toEqual(expect.any(String));
  });
});
