import * as v from 'valibot';
import { SavedReferenceCreateResponseSchema, SearchResponseSchema } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import { call, createThread, productionEnv, turnBody } from './runtime-production-http-support';

describe('production saved-reference HTTP composition', () => {
  it('resolves a selected saved reference through the production DO provider handoff', async () => {
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
    const stub = productionEnv().THREADS.getByName(consumerThreadId);
    const before = await stub.getRuntimeProductionReport();
    const turnRequestId = `runtime-production-http-saved-turn-${crypto.randomUUID()}`;
    const turnResponse = await call(`/v1/threads/${consumerThreadId}/turns`, turnRequestId, {
      method: 'POST',
      body: JSON.stringify(
        turnBody(turnRequestId, 1, '[m29-saved-reference] 保存店の詳細を確認して', undefined, [
          savedParsed.output.savedPlaceRef,
        ]),
      ),
    });
    expect(turnResponse.status).toBe(200);
    const turnParsed = v.safeParse(SearchResponseSchema, await turnResponse.json());
    expect(turnParsed.success).toBe(true);
    if (!turnParsed.success) throw new Error('saved handoff turn response was invalid');
    expect(turnParsed.output.response.kind).toBe('message');

    const after = await stub.getRuntimeProductionReport();
    expect(after).not.toBeNull();
    expect(after?.toolNames.slice(before?.toolNames.length ?? 0)).toContain('get_place_details');
    expect((after?.fetchUrls.length ?? 0) - (before?.fetchUrls.length ?? 0)).toBe(1);
    expect(after?.savedReferenceCandidateIds).toHaveLength(1);
    expect(after?.savedReferenceCandidateIds[0]).toBeTypeOf('string');
    expect(after?.savedReferenceCandidateIds[0]).not.toBe(candidateId);
    expect(JSON.stringify(turnParsed.output)).not.toContain('M16_LLM_INPUT_CANARY');
  });
});
