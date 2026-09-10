import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ThreadTurnRequest } from '@ima/contracts';
import type { TelemetryDO } from '../../src/telemetry/telemetry-do';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
} from '../../src/thread-runtime/admission';
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
  it('records the final DO result once and does not trace reference replay', async () => {
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

    const first = await tracesFor(threadId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      threadId,
      turnId: target.turnId,
      operation: 'turn',
      status: 'ok',
      resultCode: 'OK',
    });
    expect(first[0]?.durationMs).toEqual(expect.any(Number));
    expect(first[0]).not.toHaveProperty('provider');
    expect(first[0]).not.toHaveProperty('tokenCount');
    expect(first[0]).not.toHaveProperty('apiElementCount');
    expect(first[0]).not.toHaveProperty('meteredCostUsd');
    expect(JSON.stringify(first[0])).not.toMatch(
      /trace unit fixture|places\.googleapis|lat|lng|secret|token/iu,
    );

    await expect(thread.replayRuntimeTurn(target)).resolves.toMatchObject({
      status: 'reference_only',
    });
    await expect(tracesFor(threadId)).resolves.toHaveLength(1);

    const live = await productionEnv()
      .TELEMETRY.getByName('telemetry-live')
      .readTraceSince(new Date(0).toISOString());
    if (!live.ok) throw new Error(`live trace read failed: ${live.code}`);
    expect(live.records.some((record) => record.threadId === threadId)).toBe(false);
  });
});
