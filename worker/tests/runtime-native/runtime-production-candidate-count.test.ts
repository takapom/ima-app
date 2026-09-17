import * as v from 'valibot';
import { env } from 'cloudflare:test';
import { AssistantResponseSchema } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import type { ProductionThreadDO } from './runtime-production-worker';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
} from '@worker/runtime/threads/admission';

type ProductionTestEnv = Cloudflare.Env & {
  PRODUCTION_THREADS: DurableObjectNamespace<ProductionThreadDO>;
};

const productionEnv = (): ProductionTestEnv => {
  if (!('PRODUCTION_THREADS' in env)) throw new Error('M24_PRODUCTION_THREAD_BINDING_MISSING');
  return env as ProductionTestEnv;
};

const requestFor = (target: ThreadRuntimeTarget, text: string): ThreadRuntimeTurnInput => ({
  ...target,
  idempotencyKey: `m24-production-${target.turnId}`,
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
      areaText: '候補数fixture',
      budget: 'normal',
    },
    savedPlaceRefs: [],
    excludeCandidateIds: [],
    mode: 'search',
    idempotencyKey: `m24-production-${target.turnId}`,
  },
});

const targetFor = (prefix: string): ThreadRuntimeTarget => ({
  ownerScopeRef: `owner-m24-${prefix}`,
  threadId: `m24-${prefix}-${crypto.randomUUID()}`,
  turnId: `turn-${crypto.randomUUID()}`,
  revision: 1,
});

describe('production candidate cardinality through the real Think Durable Object', () => {
  it('returns a completed no-result message and performs no detail or submit call', async () => {
    const target = targetFor('zero-results');
    const stub = productionEnv().PRODUCTION_THREADS.getByName(target.threadId);
    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });

    const result = await stub.runRuntimeTurn(
      requestFor(target, '[m24-zero-results] 候補がない場合を確認して'),
    );
    expect(result.status).toBe('completed');
    const response = v.safeParse(AssistantResponseSchema, result.response);
    expect(response.success).toBe(true);
    if (!response.success) return;
    expect(response.output.kind).toBe('message');
    expect(response.output.message[0]?.text).toContain('候補は見つかりません');

    await expect(stub.getRuntimeProductionReport()).resolves.toMatchObject({
      calls: 2,
      toolNames: ['search_places', 'final_message'],
      searchResultCounts: [0],
      modelCandidateCounts: [0, 0],
      fetchUrls: ['https://webservice.recruit.co.jp/hotpepper/gourmet/v1/'],
    });
  });

  it('carries two provider candidates into model context before the normal submit path', async () => {
    const target = targetFor('two-results');
    const stub = productionEnv().PRODUCTION_THREADS.getByName(target.threadId);
    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });

    const result = await stub.runRuntimeTurn(
      requestFor(target, '[m24-two-results] 二候補を比較して'),
    );
    expect(result.status).toBe('completed');
    const response = v.safeParse(AssistantResponseSchema, result.response);
    expect(response.success).toBe(true);
    if (!response.success) return;
    expect(response.output.kind).toBe('cards');
    if (response.output.kind !== 'cards') return;
    expect(response.output.cards.alts).toHaveLength(1);
    expect(
      new Set([
        response.output.cards.hero.candidateId,
        ...response.output.cards.alts.map((card) => card.candidateId),
      ]).size,
    ).toBe(2);

    const report = await stub.getRuntimeProductionReport();
    expect(report).not.toBeNull();
    if (report === null) return;
    expect(report.searchResultCounts).toEqual([2]);
    expect(Math.max(...report.modelCandidateCounts)).toBe(2);
    expect(report.fetchUrls).toEqual([
      'https://webservice.recruit.co.jp/hotpepper/gourmet/v1/',
      'https://webservice.recruit.co.jp/hotpepper/gourmet/v1/?id=m16-production-place-1',
      'https://webservice.recruit.co.jp/hotpepper/gourmet/v1/?id=m16-production-place-2',
    ]);
  });
});
