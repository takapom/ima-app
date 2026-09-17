import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ThreadTurnRequest } from '@ima/contracts';
import type { TelemetryDO } from '@worker/adapters/outbound/persistence/telemetry/telemetry-do';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
} from '@worker/runtime/threads/admission';
import type { ProductionThreadDO } from './runtime-production-worker';

type ProductionTestEnv = Cloudflare.Env & {
  readonly PRODUCTION_THREADS: DurableObjectNamespace<ProductionThreadDO>;
  readonly TELEMETRY: DurableObjectNamespace<TelemetryDO>;
};

const productionEnv = (): ProductionTestEnv => {
  if (!('PRODUCTION_THREADS' in env) || !('TELEMETRY' in env)) {
    throw new Error('M27_RUNTIME_TRACE_BINDING_MISSING');
  }
  return env as ProductionTestEnv;
};

const requestFor = (target: ThreadRuntimeTarget): ThreadRuntimeTurnInput => {
  const idempotencyKey = `m27-trace-${target.turnId}`;
  const input = {
    schemaVersion: 'v1',
    requestId: `request-${target.turnId}`,
    turnId: target.turnId,
    revision: target.revision,
    text: 'trace unit fixture turn',
    clientNow: '2026-09-10T12:00:00.000Z',
    location: {
      status: 'unavailable' as const,
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
      areaText: '渋谷',
      budget: 'normal' as const,
    },
    savedPlaceRefs: [],
    excludeCandidateIds: [],
    mode: 'search' as const,
    idempotencyKey,
  } satisfies ThreadTurnRequest;
  return { ...target, idempotencyKey, input };
};

const tracesFor = async (threadId: string) => {
  const read = await productionEnv()
    .TELEMETRY.getByName('telemetry-fixture')
    .readTraceSince(new Date(0).toISOString());
  if (!read.ok) throw new Error(`trace read failed: ${read.code}`);
  return read.records.filter((record) => record.threadId === threadId);
};

describe('production turn telemetry', () => {
  it('records provider calls per turn and does not trace reference replay', async () => {
    const threadId = `m26-trace-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: 'owner-m26-trace',
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const thread = productionEnv().PRODUCTION_THREADS.getByName(threadId);
    await expect(thread.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });
    await expect(thread.runRuntimeTurn(requestFor(target))).resolves.toMatchObject({
      status: 'completed',
    });

    const report = await thread.getRuntimeProductionReport();
    if (report === null) throw new Error('M26_TRACE_REPORT_MISSING');
    const first = await tracesFor(threadId);
    const turns = first.filter((record) => record.operation === 'turn');
    const calls = first.filter((record) => record.operation === 'call');
    const providers = first.filter((record) => record.operation === 'provider');
    expect(turns).toHaveLength(1);
    expect(calls).toHaveLength(report.calls);
    expect(calls.length).toBeGreaterThan(0);
    expect(providers).toHaveLength(report.fetchUrls.length);
    expect(providers).toHaveLength(2);
    expect(providers.map((record) => record.provider)).toEqual(['hotpepper', 'hotpepper']);
    expect(providers.every((record) => record.status === 'ok' && record.resultCode === 'OK')).toBe(
      true,
    );
    expect(providers.every((record) => record.apiElementCount === undefined)).toBe(true);
    expect(turns[0]).toMatchObject({
      threadId,
      turnId: target.turnId,
      operation: 'turn',
      status: 'ok',
      resultCode: 'OK',
    });
    expect(turns[0]?.durationMs).toEqual(expect.any(Number));
    expect(turns[0]).not.toHaveProperty('provider');
    expect(turns[0]).not.toHaveProperty('tokenCount');
    expect(turns[0]).not.toHaveProperty('apiElementCount');
    expect(turns[0]).not.toHaveProperty('meteredCostUsd');
    expect(calls.every((record) => record.status === 'ok' && record.resultCode === 'OK')).toBe(
      true,
    );
    expect(calls.every((record) => record.provider === undefined)).toBe(true);
    expect(calls.every((record) => record.tokenCount === 2)).toBe(true);
    expect(calls.every((record) => typeof record.durationMs === 'number')).toBe(true);
    expect(JSON.stringify(turns[0])).not.toMatch(
      /trace unit fixture|places\.googleapis|lat|lng|secret|token/iu,
    );
    expect(JSON.stringify(calls)).not.toMatch(
      /trace unit fixture|places\.googleapis|lat|lng|secret/iu,
    );
    expect(JSON.stringify(providers)).not.toMatch(
      /trace unit fixture|places\.googleapis|lat|lng|secret|token/iu,
    );

    await expect(thread.replayRuntimeTurn(target)).resolves.toMatchObject({
      status: 'reference_only',
    });
    const afterReplay = await tracesFor(threadId);
    expect(afterReplay).toHaveLength(first.length);

    const secondTarget: ThreadRuntimeTarget = {
      ...target,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 2,
    };
    await expect(thread.runRuntimeTurn(requestFor(secondTarget))).resolves.toMatchObject({
      status: 'completed',
    });
    const afterSecond = await tracesFor(threadId);
    const firstTurnProviders = afterSecond.filter(
      (record) => record.operation === 'provider' && record.turnId === target.turnId,
    );
    const secondTurnProviders = afterSecond.filter(
      (record) => record.operation === 'provider' && record.turnId === secondTarget.turnId,
    );
    expect(firstTurnProviders).toHaveLength(2);
    expect(secondTurnProviders).toHaveLength(2);
    expect(
      new Set(
        afterSecond
          .filter((record) => record.operation === 'provider')
          .map((record) => record.traceId),
      ).size,
    ).toBe(4);
    expect(afterSecond.filter((record) => record.operation === 'turn')).toHaveLength(2);

    const live = await productionEnv()
      .TELEMETRY.getByName('telemetry-live')
      .readTraceSince(new Date(0).toISOString());
    if (!live.ok) throw new Error(`live trace read failed: ${live.code}`);
    expect(live.records.some((record) => record.threadId === threadId)).toBe(false);
  });
});
