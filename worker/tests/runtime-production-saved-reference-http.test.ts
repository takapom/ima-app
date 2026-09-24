import * as v from 'valibot';
import { runInDurableObject } from 'cloudflare:test';
import { SavedReferenceCreateResponseSchema, SearchResponseSchema } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import { call, createThread, productionEnv, turnBody } from './runtime-production-http-support';

describe('production saved-reference HTTP composition', () => {
  it('keeps saving and accepts savedPlaceRefs from older clients without using them', async () => {
    const sourceThreadId = await createThread();
    const searchRequestId = `runtime-production-http-saved-turn-search-${crypto.randomUUID()}`;
    const searchResponse = await call(`/v1/threads/${sourceThreadId}/turns`, searchRequestId, {
      method: 'POST',
      body: JSON.stringify(turnBody(searchRequestId, 1, '[m24-two-results] 保存参照を準備して')),
    });
    expect(searchResponse.status).toBe(200);
    const searchParsed = v.safeParse(SearchResponseSchema, await searchResponse.json());
    expect(searchParsed.success).toBe(true);
    if (!searchParsed.success || searchParsed.output.response.kind !== 'cards') {
      throw new Error('saved handoff fixture did not create cards');
    }
    const cards = searchParsed.output.response;
    const candidateId = cards.cards.hero.candidateId;
    const saveRequestId = `runtime-production-http-saved-turn-save-${crypto.randomUUID()}`;
    const saveResponse = await call(`/v1/threads/${sourceThreadId}/saved`, saveRequestId, {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId: saveRequestId,
        candidateId,
        revision: cards.revision,
        idempotencyKey: `runtime-production-http-saved-turn-key-${crypto.randomUUID()}`,
      }),
    });
    expect(saveResponse.status).toBe(201);
    const savedParsed = v.safeParse(SavedReferenceCreateResponseSchema, await saveResponse.json());
    expect(savedParsed.success).toBe(true);
    if (!savedParsed.success) throw new Error('saved handoff reference was invalid');

    const consumerThreadId = await createThread();
    const turnRequestId = `runtime-production-http-saved-turn-${crypto.randomUUID()}`;
    const turnResponse = await call(`/v1/threads/${consumerThreadId}/turns`, turnRequestId, {
      method: 'POST',
      body: JSON.stringify(
        turnBody(turnRequestId, 1, '[m24-two-results] 保存店の詳細を確認して', undefined, [
          savedParsed.output.savedPlaceRef,
        ]),
      ),
    });
    expect(turnResponse.status).toBe(200);
    expect(v.safeParse(SearchResponseSchema, await turnResponse.json()).success).toBe(true);

    // One more thread round trip gives the turn's post-response trace write time to finish
    // before this file's runner RPC closes; ending on the turn left teardown waiting minutes.
    const contextReference = await runInDurableObject(
      productionEnv().THREADS.getByName(consumerThreadId),
      (_instance, state) =>
        state.storage.sql
          .exec<{ readonly payload: string }>(
            'SELECT payload FROM runtime_context_reference LIMIT 1',
          )
          .toArray()[0]?.payload ?? null,
    );
    expect(contextReference).not.toBeNull();
    expect(contextReference).not.toContain(savedParsed.output.savedPlaceRef);
  });
});
