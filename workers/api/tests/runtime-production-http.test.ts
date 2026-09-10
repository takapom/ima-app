import * as v from 'valibot';
import { env, evictDurableObject, runInDurableObject, SELF } from 'cloudflare:test';
import {
  CreateThreadResponseSchema,
  ErrorResponseSchema,
  SearchResponseSchema,
} from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import { RuntimeProductionContextReferenceSchema } from '../src/runtime/runtime-production-context-reference';
import type { ProductionThreadDO } from './runtime-native/runtime-production-worker';
import type { RuntimeProductionCardSetSnapshot } from './runtime-native/runtime-production-model-observation';

const APP_TOKEN = 'test-app-token';
const OWNER_CREDENTIAL = 'A'.repeat(42) + 'E';
const SERVER_NOW = '2026-09-10T12:00:00Z';

type ProductionHttpTestEnv = Cloudflare.Env & {
  readonly THREADS: DurableObjectNamespace<ProductionThreadDO>;
};

const productionEnv = (): ProductionHttpTestEnv => env as ProductionHttpTestEnv;

const requestHeaders = (requestId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-app-token': APP_TOKEN,
  'x-device-id': 'runtime-production-http-device',
  'x-ima-owner-credential': OWNER_CREDENTIAL,
  'x-ima-request-id': requestId,
  'x-app-version': 'm22-runtime-production-http-test',
});

const call = async (path: string, requestId: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(requestHeaders(requestId));
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return SELF.fetch(`https://ima.test${path}`, { ...init, headers });
};

type DisplayContext = {
  readonly cardSetId: string;
  readonly promotedCandidateId: string;
  readonly selectedCandidateId: string;
  readonly candidateOrder: readonly string[];
  readonly excludeCandidateIds: readonly string[];
};

const turnBody = (
  requestId: string,
  revision: number,
  text: string,
  context?: DisplayContext,
): Record<string, unknown> => ({
  schemaVersion: 'v1',
  requestId,
  turnId: `turn-${requestId}`,
  revision,
  text,
  clientNow: SERVER_NOW,
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
    areaText: '渋谷',
    budget: 'normal',
  },
  savedPlaceRefs: [],
  excludeCandidateIds: context?.excludeCandidateIds ?? [],
  mode: 'search',
  idempotencyKey: `runtime-production-http-${requestId}`,
  ...(context === undefined
    ? {}
    : {
        cardSetId: context.cardSetId,
        promotedCandidateId: context.promotedCandidateId,
        selectedCandidateId: context.selectedCandidateId,
        candidateOrder: [...context.candidateOrder],
      }),
});

const createThread = async (): Promise<string> => {
  const requestId = `runtime-production-http-create-${crypto.randomUUID()}`;
  const response = await call('/v1/threads', requestId, {
    method: 'POST',
    body: JSON.stringify({
      schemaVersion: 'v1',
      requestId,
      idempotencyKey: `runtime-production-http-create-key-${crypto.randomUUID()}`,
    }),
  });
  expect(response.status).toBe(201);
  const parsed = v.safeParse(CreateThreadResponseSchema, await response.json());
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('production HTTP thread response was invalid');
  return parsed.output.threadId;
};

const cardSetSnapshotMatching = (
  snapshots: readonly RuntimeProductionCardSetSnapshot[],
  expected: {
    readonly cardSetId: string;
    readonly selectedCandidateId: string;
    readonly excludedCandidateId?: string;
    readonly firstCandidateId: string;
  },
): RuntimeProductionCardSetSnapshot | undefined =>
  snapshots.find(
    (snapshot) =>
      snapshot.cardSetId === expected.cardSetId &&
      snapshot.selectedCandidateId === expected.selectedCandidateId &&
      (expected.excludedCandidateId === undefined ||
        snapshot.excludedCandidateIds.includes(expected.excludedCandidateId)) &&
      snapshot.candidateOrder[0] === expected.firstCandidateId,
  );

describe('production runtime HTTP composition', () => {
  it('carries display context through HTTP, rejects stale cards, and restores inherited exclusion after eviction', async () => {
    const threadId = await createThread();
    const firstRequestId = `runtime-production-http-first-${crypto.randomUUID()}`;
    const firstResponse = await call(`/v1/threads/${threadId}/turns`, firstRequestId, {
      method: 'POST',
      body: JSON.stringify(turnBody(firstRequestId, 1, '[m24-two-results] 二つの候補を比較して')),
    });
    expect(firstResponse.status).toBe(200);
    const firstParsed = v.safeParse(SearchResponseSchema, await firstResponse.json());
    expect(firstParsed.success).toBe(true);
    if (!firstParsed.success) throw new Error('first production HTTP response was invalid');
    expect(firstParsed.output.response.kind).toBe('cards');
    if (firstParsed.output.response.kind !== 'cards') {
      throw new Error('first production HTTP response did not contain cards');
    }
    const firstCards = firstParsed.output.response;
    const firstCandidateIds = [
      firstCards.cards.hero.candidateId,
      ...firstCards.cards.alts.map((card) => card.candidateId),
    ];
    expect(firstCandidateIds).toHaveLength(2);
    if (firstCards.cardSetId === null) throw new Error('first card set id was missing');
    const selectedCandidateId = firstCandidateIds[1];
    const excludedCandidateId = firstCandidateIds[0];
    if (selectedCandidateId === undefined || excludedCandidateId === undefined) {
      throw new Error('two-candidate fixture was incomplete');
    }

    const secondRequestId = `runtime-production-http-replace-${crypto.randomUUID()}`;
    const secondResponse = await call(`/v1/threads/${threadId}/turns`, secondRequestId, {
      method: 'POST',
      body: JSON.stringify(
        turnBody(secondRequestId, 2, '[m16-condition-change] 条件を変えて探し直して', {
          cardSetId: firstCards.cardSetId,
          promotedCandidateId: selectedCandidateId,
          selectedCandidateId,
          candidateOrder: [selectedCandidateId],
          excludeCandidateIds: [excludedCandidateId],
        }),
      ),
    });
    expect(secondResponse.status).toBe(200);
    const secondParsed = v.safeParse(SearchResponseSchema, await secondResponse.json());
    expect(secondParsed.success).toBe(true);
    if (!secondParsed.success) throw new Error('second production HTTP response was invalid');
    expect(secondParsed.output.response.kind).toBe('cards');
    if (secondParsed.output.response.kind !== 'cards') {
      throw new Error('second production HTTP response did not contain cards');
    }
    const secondCards = secondParsed.output.response;
    expect(secondCards.cardSetId).not.toBe(firstCards.cardSetId);
    if (secondCards.cardSetId === null) throw new Error('replacement card set id was missing');
    const secondCandidateIds = [
      secondCards.cards.hero.candidateId,
      ...secondCards.cards.alts.map((card) => card.candidateId),
    ];
    const secondSelectedCandidateId = secondCandidateIds[0];
    if (secondSelectedCandidateId === undefined) throw new Error('replacement cards were empty');

    const productionStub = productionEnv().THREADS.getByName(threadId);
    const secondReport = await productionStub.getRuntimeProductionReport();
    expect(secondReport?.modelCardSetSeen).toBe(true);
    expect(
      secondReport === null
        ? undefined
        : cardSetSnapshotMatching(secondReport.modelCardSetSnapshots, {
            cardSetId: firstCards.cardSetId,
            selectedCandidateId,
            excludedCandidateId,
            firstCandidateId: selectedCandidateId,
          }),
    ).toBeDefined();

    const staleRequestId = `runtime-production-http-stale-${crypto.randomUUID()}`;
    const staleResponse = await call(`/v1/threads/${threadId}/turns`, staleRequestId, {
      method: 'POST',
      body: JSON.stringify(
        turnBody(staleRequestId, 3, '[m16-follow-up] 古いcardSetを参照', {
          cardSetId: firstCards.cardSetId,
          promotedCandidateId: selectedCandidateId,
          selectedCandidateId,
          candidateOrder: [selectedCandidateId],
          excludeCandidateIds: [excludedCandidateId],
        }),
      ),
    });
    expect(staleResponse.status).toBe(409);
    const staleParsed = v.safeParse(ErrorResponseSchema, await staleResponse.json());
    expect(staleParsed.success).toBe(true);
    if (!staleParsed.success) throw new Error('stale production HTTP error response was invalid');
    expect(staleParsed.output.code).toBe('CONFLICT');

    await evictDurableObject(productionStub);
    const restoredRequestId = `runtime-production-http-restored-${crypto.randomUUID()}`;
    const restoredResponse = await call(`/v1/threads/${threadId}/turns`, restoredRequestId, {
      method: 'POST',
      body: JSON.stringify(
        turnBody(restoredRequestId, 3, '[m16-follow-up] 前の候補を維持して', {
          cardSetId: secondCards.cardSetId,
          promotedCandidateId: secondSelectedCandidateId,
          selectedCandidateId: secondSelectedCandidateId,
          candidateOrder: secondCandidateIds,
          excludeCandidateIds: [excludedCandidateId],
        }),
      ),
    });
    expect(restoredResponse.status).toBe(200);
    const restoredParsed = v.safeParse(SearchResponseSchema, await restoredResponse.json());
    expect(restoredParsed.success).toBe(true);
    if (!restoredParsed.success) {
      throw new Error('restored production HTTP response was invalid');
    }
    const restoredReport = await productionEnv()
      .THREADS.getByName(threadId)
      .getRuntimeProductionReport();
    expect(restoredReport?.modelCardSetSeen).toBe(true);
    expect(
      restoredReport === null
        ? undefined
        : cardSetSnapshotMatching(restoredReport.modelCardSetSnapshots, {
            cardSetId: secondCards.cardSetId,
            selectedCandidateId: secondSelectedCandidateId,
            firstCandidateId: secondSelectedCandidateId,
          }),
    ).toBeDefined();
    const restoredReference = await runInDurableObject(
      productionEnv().THREADS.getByName(threadId),
      (_instance, state) =>
        state.storage.sql
          .exec<{ readonly payload: string }>(
            'SELECT payload FROM runtime_context_reference LIMIT 1',
          )
          .toArray()[0]?.payload ?? null,
    );
    const parsedReference = v.safeParse(
      RuntimeProductionContextReferenceSchema,
      restoredReference === null ? null : JSON.parse(restoredReference),
    );
    expect(parsedReference.success).toBe(true);
    if (!parsedReference.success) throw new Error('runtime context reference was invalid');
    expect(parsedReference.output.excludedCandidateIds).toContain(excludedCandidateId);
  });
});
