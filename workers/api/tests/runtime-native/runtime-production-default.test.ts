import * as v from 'valibot';
import { env } from 'cloudflare:test';
import { AssistantResponseSchema } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import { OPENAI_PROVIDER_REQUEST_OPTIONS } from '../../src/model/provider-options';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
} from '../../src/thread-runtime/admission';
import type { ProductionThreadDO, RuntimeProductionReport } from './runtime-production-worker';

type ProductionTestEnv = Cloudflare.Env & {
  PRODUCTION_THREADS: DurableObjectNamespace<ProductionThreadDO>;
};

const productionEnv = (): ProductionTestEnv => {
  if (!('PRODUCTION_THREADS' in env)) throw new Error('M16_PRODUCTION_THREAD_BINDING_MISSING');
  return env as ProductionTestEnv;
};

const requestFor = (
  target: ThreadRuntimeTarget,
  text = '渋谷で静かなカフェを探して',
): ThreadRuntimeTurnInput => ({
  ...target,
  idempotencyKey: `m16-production-${target.turnId}`,
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
      areaText: '別地域へ誤フォールバックさせない',
      budget: 'normal',
    },
    savedPlaceRefs: [],
    excludeCandidateIds: [],
    mode: 'search',
    idempotencyKey: `m16-production-${target.turnId}`,
  },
});

describe('production factory through a real Think Durable Object', () => {
  it('runs default search, details, submit, replay, and the next turn', async () => {
    const threadId = `m16-production-${crypto.randomUUID()}`;
    const first: ThreadRuntimeTarget = {
      ownerScopeRef: 'owner-m16-production',
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);

    await expect(stub.initialize(first.ownerScopeRef, first.threadId)).resolves.toMatchObject({
      ok: true,
    });
    const firstResult = await stub.runRuntimeTurn(requestFor(first));
    expect(firstResult.status).toBe('completed');
    const firstResponse = v.safeParse(AssistantResponseSchema, firstResult.response);
    expect(firstResponse.success).toBe(true);
    if (!firstResponse.success) return;
    expect(firstResponse.output.kind).toBe('cards');
    expect(firstResponse.output.revision).toBe(2);
    expect(firstResponse.output.cardSetId).toMatch(/^runtime-card-set-/u);

    const report: RuntimeProductionReport | null = await stub.getRuntimeProductionReport();
    expect(report).not.toBeNull();
    if (report === null) return;
    expect(report.calls).toBe(3);
    expect(report.fetchUrls).toEqual([
      'https://places.googleapis.com/v1/places:searchText',
      'https://places.googleapis.com/v1/places/m16-production-place',
    ]);
    expect(report.providerOptionsSeen).toEqual([
      OPENAI_PROVIDER_REQUEST_OPTIONS,
      OPENAI_PROVIDER_REQUEST_OPTIONS,
      OPENAI_PROVIDER_REQUEST_OPTIONS,
    ]);

    await expect(stub.replayRuntimeTurn(first)).resolves.toMatchObject({
      status: 'reference_only',
      response: {
        turnId: first.turnId,
        revision: 2,
        responseId: firstResponse.output.responseId,
        cardSetId: firstResponse.output.cardSetId,
        restoreMode: 'reference_only',
      },
    });

    const second: ThreadRuntimeTarget = {
      ...first,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 2,
    };
    const secondResult = await stub.runRuntimeTurn(requestFor(second));
    expect(secondResult.status).toBe('completed');
    expect(secondResult.response).toMatchObject({
      kind: 'cards',
      turnId: second.turnId,
      revision: 3,
    });
    if (secondResult.response === null) return;
    expect(secondResult.response.responseId).not.toBe(firstResponse.output.responseId);
    const secondReport: RuntimeProductionReport | null = await stub.getRuntimeProductionReport();
    expect(secondReport?.calls).toBe(6);
  });

  it('admits a host-marked final message inside the final response reserve', async () => {
    const threadId = `m16-production-final-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: 'owner-m16-production-final',
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);

    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });
    const result = await stub.runRuntimeTurn(
      requestFor(target, '[m16-final-reserve] 条件を確認して'),
    );
    expect(result.status).toBe('completed');
    const response = v.safeParse(AssistantResponseSchema, result.response);
    expect(response.success).toBe(true);
    if (!response.success) return;
    expect(response.output).toMatchObject({
      kind: 'message',
      revision: 2,
      cardSetId: null,
    });

    const report: RuntimeProductionReport | null = await stub.getRuntimeProductionReport();
    expect(report).toMatchObject({
      calls: 1,
      finalResponseFlags: [true],
      fetchUrls: [],
    });
  });
});
