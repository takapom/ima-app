import * as v from 'valibot';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import {
  ErrorResponseSchema,
  SavedReferenceCreateResponseSchema,
  SearchResponseSchema,
} from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import { RuntimeProductionContextReferenceSchema } from '@worker/runtime/context/runtime-production-context-reference';
import type { RuntimeProductionCardSetSnapshot } from './runtime-native/runtime-production-model-observation';
import { call, createThread, productionEnv, turnBody } from './runtime-production-http-support';

const OTHER_OWNER_CREDENTIAL = 'B'.repeat(42) + 'E';

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
  it('leaves the removed photo provider unavailable', async () => {
    const requestId = `photo-disabled-${crypto.randomUUID()}`;
    const response = await call('/v1/photos/removed-provider-token', requestId, { method: 'GET' });
    expect(response.status).toBe(404);
  });

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

  it('saves and replays a server-resolved candidate across HTTP and DO eviction', async () => {
    const threadId = await createThread();
    const searchRequestId = `runtime-production-http-save-search-${crypto.randomUUID()}`;
    const searchResponse = await call(`/v1/threads/${threadId}/turns`, searchRequestId, {
      method: 'POST',
      body: JSON.stringify(
        turnBody(searchRequestId, 1, '[m24-two-results] 保存候補を二つ取得して'),
      ),
    });
    expect(searchResponse.status).toBe(200);
    const searchParsed = v.safeParse(SearchResponseSchema, await searchResponse.json());
    expect(searchParsed.success).toBe(true);
    if (!searchParsed.success || searchParsed.output.response.kind !== 'cards') {
      throw new Error('saved reference fixture did not create cards');
    }
    const cards = searchParsed.output.response;
    const candidateId = cards.cards.hero.candidateId;
    const alternateCandidateId = cards.cards.alts[0]?.candidateId;
    if (cards.revision < 2 || alternateCandidateId === undefined) {
      throw new Error('saved reference fixture did not create two candidates');
    }
    const idempotencyKey = `runtime-production-http-save-${crypto.randomUUID()}`;
    const saveBody = (
      requestId: string,
      candidate: string,
      key = idempotencyKey,
      revision = cards.revision,
    ) => ({
      schemaVersion: 'v1',
      requestId,
      candidateId: candidate,
      revision,
      idempotencyKey: key,
    });

    const foreignSaveRequestId = `runtime-production-http-save-foreign-${crypto.randomUUID()}`;
    const foreignSave = await call(
      `/v1/threads/${threadId}/saved`,
      foreignSaveRequestId,
      {
        method: 'POST',
        body: JSON.stringify(saveBody(foreignSaveRequestId, candidateId)),
      },
      OTHER_OWNER_CREDENTIAL,
    );
    expect(foreignSave.status).toBe(403);
    const foreignSaveParsed = v.safeParse(ErrorResponseSchema, await foreignSave.json());
    expect(foreignSaveParsed.success).toBe(true);
    if (!foreignSaveParsed.success) throw new Error('foreign saved request was invalid');
    expect(foreignSaveParsed.output.code).toBe('FORBIDDEN');

    const staleSaveRequestId = `runtime-production-http-save-stale-${crypto.randomUUID()}`;
    const staleSave = await call(`/v1/threads/${threadId}/saved`, staleSaveRequestId, {
      method: 'POST',
      body: JSON.stringify(
        saveBody(
          staleSaveRequestId,
          candidateId,
          `runtime-production-http-save-stale-${crypto.randomUUID()}`,
          1,
        ),
      ),
    });
    expect(staleSave.status).toBe(409);
    const staleSaveParsed = v.safeParse(ErrorResponseSchema, await staleSave.json());
    expect(staleSaveParsed.success).toBe(true);
    if (!staleSaveParsed.success) throw new Error('stale saved request was invalid');
    expect(staleSaveParsed.output.code).toBe('STALE_TURN');

    const firstSaveRequestId = `runtime-production-http-save-first-${crypto.randomUUID()}`;
    const firstSave = await call(`/v1/threads/${threadId}/saved`, firstSaveRequestId, {
      method: 'POST',
      body: JSON.stringify(saveBody(firstSaveRequestId, candidateId)),
    });
    expect(firstSave.status).toBe(201);
    const firstSaveParsed = v.safeParse(SavedReferenceCreateResponseSchema, await firstSave.json());
    expect(firstSaveParsed.success).toBe(true);
    if (!firstSaveParsed.success) throw new Error('saved reference response was invalid');

    const retryRequestId = `runtime-production-http-save-retry-${crypto.randomUUID()}`;
    const retry = await call(`/v1/threads/${threadId}/saved`, retryRequestId, {
      method: 'POST',
      body: JSON.stringify(saveBody(retryRequestId, candidateId)),
    });
    expect(retry.status).toBe(201);
    const retryParsed = v.safeParse(SavedReferenceCreateResponseSchema, await retry.json());
    expect(retryParsed.success).toBe(true);
    if (!retryParsed.success) throw new Error('saved reference retry response was invalid');
    expect(retryParsed.output.savedPlaceRef).toBe(firstSaveParsed.output.savedPlaceRef);

    const conflictRequestId = `runtime-production-http-save-conflict-${crypto.randomUUID()}`;
    const conflict = await call(`/v1/threads/${threadId}/saved`, conflictRequestId, {
      method: 'POST',
      body: JSON.stringify(saveBody(conflictRequestId, alternateCandidateId)),
    });
    expect(conflict.status).toBe(409);
    const conflictParsed = v.safeParse(ErrorResponseSchema, await conflict.json());
    expect(conflictParsed.success).toBe(true);
    if (!conflictParsed.success) throw new Error('saved reference conflict response was invalid');
    expect(conflictParsed.output.code).toBe('CONFLICT');

    const invalidRequestId = `runtime-production-http-save-invalid-${crypto.randomUUID()}`;
    const invalid = await call(`/v1/threads/${threadId}/saved`, invalidRequestId, {
      method: 'POST',
      body: JSON.stringify({
        ...saveBody(invalidRequestId, candidateId),
        provider: 'google_places',
      }),
    });
    expect(invalid.status).toBe(400);

    await evictDurableObject(productionEnv().THREADS.getByName(threadId));
    const afterEvictionRequestId = `runtime-production-http-save-eviction-${crypto.randomUUID()}`;
    const afterEviction = await call(`/v1/threads/${threadId}/saved`, afterEvictionRequestId, {
      method: 'POST',
      body: JSON.stringify(saveBody(afterEvictionRequestId, candidateId)),
    });
    expect(afterEviction.status).toBe(201);
    const afterEvictionParsed = v.safeParse(
      SavedReferenceCreateResponseSchema,
      await afterEviction.json(),
    );
    expect(afterEvictionParsed.success).toBe(true);
    if (!afterEvictionParsed.success) throw new Error('evicted saved reference replay was invalid');
    expect(afterEvictionParsed.output.savedPlaceRef).toBe(firstSaveParsed.output.savedPlaceRef);

    const postEvictionKey = `runtime-production-http-save-post-eviction-${crypto.randomUUID()}`;
    const postEvictionRequestId = `runtime-production-http-save-post-eviction-${crypto.randomUUID()}`;
    const postEvictionSave = await call(`/v1/threads/${threadId}/saved`, postEvictionRequestId, {
      method: 'POST',
      body: JSON.stringify(saveBody(postEvictionRequestId, alternateCandidateId, postEvictionKey)),
    });
    expect(postEvictionSave.status).toBe(201);
    const postEvictionParsed = v.safeParse(
      SavedReferenceCreateResponseSchema,
      await postEvictionSave.json(),
    );
    expect(postEvictionParsed.success).toBe(true);
    if (!postEvictionParsed.success) throw new Error('post-eviction saved reference was invalid');
    expect(postEvictionParsed.output.savedPlaceRef).not.toBe(firstSaveParsed.output.savedPlaceRef);

    const otherThreadId = await createThread();
    const crossThreadRequestId = `runtime-production-http-save-cross-thread-${crypto.randomUUID()}`;
    const crossThread = await call(`/v1/threads/${otherThreadId}/saved`, crossThreadRequestId, {
      method: 'POST',
      body: JSON.stringify(saveBody(crossThreadRequestId, candidateId)),
    });
    // The owner-level idempotency ledger sees the same key with a different
    // thread-bound fingerprint and must reject it without replaying the ref.
    expect(crossThread.status).toBe(409);
    const crossThreadParsed = v.safeParse(ErrorResponseSchema, await crossThread.json());
    expect(crossThreadParsed.success).toBe(true);
    if (!crossThreadParsed.success) throw new Error('cross-thread saved response was invalid');
    expect(crossThreadParsed.output.code).toBe('CONFLICT');

    const foreignDeleteRequestId = `runtime-production-http-save-foreign-delete-${crypto.randomUUID()}`;
    const foreignDelete = await call(
      `/v1/saved/${firstSaveParsed.output.savedPlaceRef}`,
      foreignDeleteRequestId,
      {
        method: 'DELETE',
        body: JSON.stringify({
          schemaVersion: 'v1',
          requestId: foreignDeleteRequestId,
          idempotencyKey: `runtime-production-http-save-foreign-delete-key-${crypto.randomUUID()}`,
        }),
      },
      OTHER_OWNER_CREDENTIAL,
    );
    expect(foreignDelete.status).toBe(204);

    const replayAfterForeignDeleteRequestId = `runtime-production-http-save-owner-replay-${crypto.randomUUID()}`;
    const replayAfterForeignDelete = await call(
      `/v1/threads/${threadId}/saved`,
      replayAfterForeignDeleteRequestId,
      {
        method: 'POST',
        body: JSON.stringify(saveBody(replayAfterForeignDeleteRequestId, candidateId)),
      },
    );
    expect(replayAfterForeignDelete.status).toBe(201);
    const replayAfterForeignDeleteParsed = v.safeParse(
      SavedReferenceCreateResponseSchema,
      await replayAfterForeignDelete.json(),
    );
    expect(replayAfterForeignDeleteParsed.success).toBe(true);
    if (!replayAfterForeignDeleteParsed.success) {
      throw new Error('owner replay after foreign delete was invalid');
    }
    expect(replayAfterForeignDeleteParsed.output.savedPlaceRef).toBe(
      firstSaveParsed.output.savedPlaceRef,
    );

    const deleteRequestId = `runtime-production-http-save-delete-${crypto.randomUUID()}`;
    const deleted = await call(
      `/v1/saved/${firstSaveParsed.output.savedPlaceRef}`,
      deleteRequestId,
      {
        method: 'DELETE',
        body: JSON.stringify({
          schemaVersion: 'v1',
          requestId: deleteRequestId,
          idempotencyKey: `runtime-production-http-save-delete-key-${crypto.randomUUID()}`,
        }),
      },
    );
    expect(deleted.status).toBe(204);

    const resurrectRequestId = `runtime-production-http-save-resurrect-${crypto.randomUUID()}`;
    const resurrect = await call(`/v1/threads/${threadId}/saved`, resurrectRequestId, {
      method: 'POST',
      body: JSON.stringify(saveBody(resurrectRequestId, candidateId)),
    });
    expect(resurrect.status).toBe(409);
  });
});
