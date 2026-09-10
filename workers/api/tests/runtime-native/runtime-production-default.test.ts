import * as v from 'valibot';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { AssistantResponseSchema } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import { OPENAI_PROVIDER_REQUEST_OPTIONS } from '../../src/model/provider-options';
import { sessionExpiryAt } from '../../src/runtime/runtime-production-support';
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

type RuntimeRetentionAnchorRow = { readonly thread_created_at: string };

const readRetentionAnchor = (stub: DurableObjectStub<ProductionThreadDO>) =>
  runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql
      .exec<RuntimeRetentionAnchorRow>(
        'SELECT thread_created_at FROM runtime_retention_anchor WHERE singleton = 1',
      )
      .toArray()[0];
    return row?.thread_created_at ?? null;
  });

const readThinkPersistence = (stub: DurableObjectStub<ProductionThreadDO>) =>
  runInDurableObject(stub, (_instance, state) => {
    const messages = state.storage.sql
      .exec<{ readonly content: string }>('SELECT content FROM assistant_messages')
      .toArray()
      .map((row) => row.content);
    const compactions = state.storage.sql
      .exec<{ readonly summary: string }>('SELECT summary FROM assistant_compactions')
      .toArray()
      .map((row) => row.summary);
    const indexed = state.storage.sql
      .exec<{ readonly content: string }>('SELECT content FROM assistant_fts')
      .toArray()
      .map((row) => row.content);
    return {
      rows: messages.length + compactions.length + indexed.length,
      containsProviderCanary: [...messages, ...compactions, ...indexed].some((value) =>
        value.includes('M16_LLM_INPUT_CANARY'),
      ),
      containsDeniedCanary: [...messages, ...compactions, ...indexed].some((value) =>
        value.includes('M16_DENIED_FIELD_CANARY'),
      ),
    };
  });

const corruptRetentionAnchor = (stub: DurableObjectStub<ProductionThreadDO>) =>
  runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      'UPDATE runtime_retention_anchor SET thread_created_at = ? WHERE singleton = 1',
      'not-an-iso-timestamp',
    );
  });

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

  it('carries committed history and cards across a follow-up, then replaces them after a condition change', async () => {
    const threadId = `m16-production-multiturn-${crypto.randomUUID()}`;
    const first: ThreadRuntimeTarget = {
      ownerScopeRef: 'owner-m16-production-multiturn',
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);

    await expect(stub.initialize(first.ownerScopeRef, first.threadId)).resolves.toMatchObject({
      ok: true,
    });
    const firstResult = await stub.runRuntimeTurn(
      requestFor(first, '[m16-multiturn] 静かなカフェを探して'),
    );
    expect(firstResult.status).toBe('completed');
    const firstResponse = v.safeParse(AssistantResponseSchema, firstResult.response);
    expect(firstResponse.success).toBe(true);
    if (!firstResponse.success) throw new Error('first multi-turn response was invalid');
    expect(firstResponse.output.kind).toBe('cards');
    if (firstResponse.output.kind !== 'cards') throw new Error('first response was not cards');

    const followUp: ThreadRuntimeTarget = {
      ...first,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 2,
    };
    const followUpResult = await stub.runRuntimeTurn(
      requestFor(followUp, '[m16-follow-up] 前の候補について教えて'),
    );
    expect(followUpResult.status).toBe('completed');
    const followUpResponse = v.safeParse(AssistantResponseSchema, followUpResult.response);
    expect(followUpResponse.success).toBe(true);
    if (!followUpResponse.success) throw new Error('follow-up response was invalid');
    expect(followUpResponse.output.kind).toBe('message');
    expect(followUpResponse.output.message[0]?.text).toContain('前の候補');
    expect(followUpResponse.output.presentation).toBe('keep');

    const changed: ThreadRuntimeTarget = {
      ...first,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 3,
    };
    const changedResult = await stub.runRuntimeTurn({
      ...requestFor(changed, '[m16-condition-change] 予算を下げて探し直して'),
      input: {
        ...requestFor(changed, '[m16-condition-change] 予算を下げて探し直して').input,
        prefs: {
          ...requestFor(changed).input.prefs,
          budget: 'cheap',
        },
      },
    });
    expect(changedResult.status).toBe('completed');
    const changedResponse = v.safeParse(AssistantResponseSchema, changedResult.response);
    expect(changedResponse.success).toBe(true);
    if (!changedResponse.success) throw new Error('changed-condition response was invalid');
    expect(changedResponse.output.kind).toBe('cards');
    if (changedResponse.output.kind !== 'cards') {
      throw new Error('changed-condition response was not cards');
    }
    expect(changedResponse.output.cardSetId).not.toBe(firstResponse.output.cardSetId);

    const report = await stub.getRuntimeProductionReport();
    expect(report).toMatchObject({
      calls: 7,
      toolNames: [
        'search_places',
        'get_place_details',
        'submit_cards',
        'final_message',
        'search_places',
        'get_place_details',
        'submit_cards',
      ],
      modelHistorySeen: true,
      modelCardSetSeen: true,
      llmInputCanarySeen: true,
    });
    const persistence = await readThinkPersistence(stub);
    expect(persistence.rows).toBeGreaterThan(0);
    expect(persistence.containsProviderCanary).toBe(false);
    expect(persistence.containsDeniedCanary).toBe(false);
  });

  it('enters final-only mode from the runtime budget reserve', async () => {
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

  it('returns a typed failure when final-only output tries to call a tool', async () => {
    const threadId = `m16-production-late-tool-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: 'owner-m16-production-late-tool',
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);

    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      stub.runRuntimeTurn(requestFor(target, '[m16-late-tool] final response with a tool')),
    ).resolves.toMatchObject({
      status: 'failed',
      code: 'RUNTIME_FAILED',
      response: null,
    });

    await expect(stub.getRuntimeProductionReport()).resolves.toMatchObject({
      calls: 1,
      finalResponseFlags: [true],
      toolNames: ['search_places'],
      fetchUrls: [],
    });
    await expect(stub.replayRuntimeTurn(target)).resolves.toEqual({
      status: 'unavailable',
      code: 'NOT_FOUND',
    });
  });

  it('blocks a final-only submit before the CommitPort can run', async () => {
    const threadId = `m16-production-late-submit-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: 'owner-m16-production-late-submit',
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);

    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      stub.runRuntimeTurn(requestFor(target, '[m16-late-submit] final response with cards')),
    ).resolves.toMatchObject({
      status: 'failed',
      code: 'RUNTIME_FAILED',
      response: null,
    });

    await expect(stub.getRuntimeProductionReport()).resolves.toMatchObject({
      calls: 1,
      finalResponseFlags: [true],
      toolNames: ['submit_cards'],
      fetchUrls: [],
    });
    await expect(stub.replayRuntimeTurn(target)).resolves.toEqual({
      status: 'unavailable',
      code: 'NOT_FOUND',
    });
  });

  it('returns a typed failure without another model call after budget exhaustion', async () => {
    const threadId = `m16-production-exhausted-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: 'owner-m16-production-exhausted',
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);

    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      stub.runRuntimeTurn(requestFor(target, '[m16-exhausted-budget] no extra model call')),
    ).resolves.toMatchObject({
      status: 'failed',
      code: 'RUNTIME_FAILED',
      response: null,
    });

    await expect(stub.getRuntimeProductionReport()).resolves.toMatchObject({
      calls: 0,
      toolNames: [],
      fetchUrls: [],
    });
  });

  it('keeps llm_input usable when display and persistence are denied', async () => {
    const threadId = `m16-production-llm-only-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: 'owner-m16-production-llm-only',
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = productionEnv().PRODUCTION_THREADS.getByName(threadId);

    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });
    const result = await stub.runRuntimeTurn(
      requestFor(target, '[m16-llm-only] 検索結果を読んで短く返して'),
    );
    expect(result.status).toBe('completed');
    const response = v.safeParse(AssistantResponseSchema, result.response);
    expect(response.success).toBe(true);
    if (!response.success) return;
    expect(response.output.kind).toBe('message');
    expect(response.output.message[0]?.retention).toMatchObject({
      retentionDecision: 'deny',
      displayPolicyStatus: 'policy_withheld',
    });

    const report: RuntimeProductionReport | null = await stub.getRuntimeProductionReport();
    expect(report).toMatchObject({
      calls: 3,
      toolNames: ['search_places', 'get_place_details', 'final_message'],
      llmInputCanarySeen: true,
      deniedFieldCanarySeen: false,
    });
    expect(report?.observationIdsSeen.some((ids) => ids.length > 0)).toBe(true);
  });

  it('keeps the durable 05:00 JST anchor across eviction and rejects corruption', async () => {
    expect(sessionExpiryAt('2026-09-10T19:59:00.000Z')).toBe('2026-09-10T20:00:00.000Z');
    expect(sessionExpiryAt('2026-09-10T20:00:00.000Z')).toBe('2026-09-11T20:00:00.000Z');

    const threadId = `m16-production-anchor-${crypto.randomUUID()}`;
    const first: ThreadRuntimeTarget = {
      ownerScopeRef: 'owner-m16-production-anchor',
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const namespace = productionEnv().PRODUCTION_THREADS;
    const stub = namespace.getByName(threadId);

    await expect(stub.initialize(first.ownerScopeRef, first.threadId)).resolves.toMatchObject({
      ok: true,
    });
    const firstAnchor = await readRetentionAnchor(stub);
    expect(firstAnchor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    await expect(stub.runRuntimeTurn(requestFor(first))).resolves.toMatchObject({
      status: 'completed',
    });

    await evictDurableObject(stub);
    const reopened = namespace.getByName(threadId);
    const second: ThreadRuntimeTarget = {
      ...first,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 2,
    };
    await expect(reopened.runRuntimeTurn(requestFor(second))).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(readRetentionAnchor(reopened)).resolves.toBe(firstAnchor);

    await corruptRetentionAnchor(reopened);
    await evictDurableObject(reopened);
    const corrupted = namespace.getByName(threadId);
    await expect(corrupted.getRuntimeAnchorStatus()).resolves.toEqual({
      status: 'invalid',
      code: 'RUNTIME_RETENTION_ANCHOR_INVALID',
    });
  });
});
