import * as v from 'valibot';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { AssistantResponseSchema } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
} from '@worker/runtime/threads/admission';
import { RuntimeProductionContextReferenceSchema } from '@worker/runtime/context/runtime-production-context-reference';
import type { ProductionThreadDO } from './runtime-production-worker';
import { createSessionExpiryGate } from '@worker/application/use-cases/expire-session/expire-session';

type ProductionTestEnv = Cloudflare.Env & {
  readonly PRODUCTION_THREADS: DurableObjectNamespace<ProductionThreadDO>;
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
  idempotencyKey: `m16-context-${target.turnId}`,
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
      areaText: '現在地周辺',
      budget: 'normal',
    },
    excludeCandidateIds: [],
    mode: 'search',
    idempotencyKey: `m16-context-${target.turnId}`,
  },
});

const readContextPayload = (stub: DurableObjectStub<ProductionThreadDO>) =>
  runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql
      .exec<{ readonly payload: string }>('SELECT payload FROM runtime_context_reference LIMIT 1')
      .toArray()[0];
    return row?.payload ?? null;
  });

const readRuntimeRows = (stub: DurableObjectStub<ProductionThreadDO>) =>
  runInDurableObject(stub, (_instance, state) => ({
    context:
      state.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM runtime_context_reference')
        .toArray()[0]?.count ?? 0,
    commits:
      state.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM runtime_commit')
        .toArray()[0]?.count ?? 0,
    messages:
      state.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM assistant_messages')
        .toArray()[0]?.count ?? 0,
  }));

const expireAnchor = (stub: DurableObjectStub<ProductionThreadDO>) =>
  runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      'UPDATE runtime_retention_anchor SET thread_created_at = ? WHERE singleton = 1',
      '2026-09-09T19:59:00.000Z',
    );
  });

describe('M16 durable runtime context boundary', () => {
  it('retries incomplete expiry cleanup while remaining fail-closed', async () => {
    let runtimeAttempts = 0;
    let contextAttempts = 0;
    let photoAttempts = 0;
    let failRuntime = true;
    const gate = createSessionExpiryGate({
      isExpired: () => true,
      readScope: () => ({ ownerScopeRef: 'owner', threadId: 'thread' }),
      cleanupRuntime: () => {
        runtimeAttempts += 1;
        if (failRuntime) throw new Error('RUNTIME_CLEANUP_RETRY');
        return Promise.resolve();
      },
      clearContext: () => {
        contextAttempts += 1;
      },
      clearPhotos: () => {
        photoAttempts += 1;
        return Promise.resolve();
      },
    });

    await expect(gate()).resolves.toBe(true);
    expect({ runtimeAttempts, contextAttempts, photoAttempts }).toEqual({
      runtimeAttempts: 1,
      contextAttempts: 1,
      photoAttempts: 1,
    });
    failRuntime = false;
    await expect(gate()).resolves.toBe(true);
    await expect(gate()).resolves.toBe(true);
    expect({ runtimeAttempts, contextAttempts, photoAttempts }).toEqual({
      runtimeAttempts: 2,
      contextAttempts: 2,
      photoAttempts: 2,
    });
  });

  it('restores permitted conversation text and candidate references after DO eviction', async () => {
    const threadId = `m16-context-restore-${crypto.randomUUID()}`;
    const ownerScopeRef = `m16-context-owner-${crypto.randomUUID()}`;
    const namespace = productionEnv().PRODUCTION_THREADS;
    const first: ThreadRuntimeTarget = {
      ownerScopeRef,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = namespace.getByName(threadId);

    await stub.configureRuntimeScenario('multi-turn');
    await expect(stub.initialize(ownerScopeRef, threadId)).resolves.toMatchObject({ ok: true });
    const firstResult = await stub.runRuntimeTurn(
      requestFor(first, '[m16-multiturn] 静かなカフェを探して'),
    );
    expect(firstResult.status).toBe('completed');
    const firstResponse = v.safeParse(AssistantResponseSchema, firstResult.response);
    expect(firstResponse.success).toBe(true);
    if (!firstResponse.success || firstResponse.output.kind !== 'cards') {
      throw new Error('reference restore fixture did not create cards');
    }
    const excludedCandidateId = firstResponse.output.cards.hero.candidateId;
    const current = await stub.read(ownerScopeRef);
    if (!current.ok) throw new Error('reference restore fixture lost its thread binding');
    await expect(
      stub.resolveCandidateForSavedReference(
        ownerScopeRef,
        excludedCandidateId,
        current.snapshot.revision,
      ),
    ).resolves.toEqual({
      ok: true,
      candidateId: excludedCandidateId,
      provider: 'hotpepper',
      recordRef: 'm16-production-place',
    });
    await expect(
      stub.resolveCandidateForSavedReference(
        `m16-other-owner-${crypto.randomUUID()}`,
        excludedCandidateId,
        current.snapshot.revision,
      ),
    ).resolves.toEqual({ ok: false, code: 'FORBIDDEN' });

    const payload = await readContextPayload(stub);
    expect(payload).not.toBeNull();
    expect(payload).not.toContain('M16_LLM_INPUT_CANARY');
    expect(payload).not.toContain('M16_DENIED_FIELD_CANARY');
    expect(payload).toContain('"candidateIdentities"');
    expect(payload).toContain('"recordRef":"m16-production-place"');
    expect(payload).toContain('"history"');
    expect(payload).toContain('[m16-multiturn] 静かなカフェを探して');
    expect(payload).toContain('"cardSet"');

    await evictDurableObject(stub);
    const reopened = namespace.getByName(threadId);
    await expect(
      reopened.resolveCandidateForSavedReference(
        ownerScopeRef,
        excludedCandidateId,
        current.snapshot.revision,
      ),
    ).resolves.toEqual({
      ok: true,
      candidateId: excludedCandidateId,
      provider: 'hotpepper',
      recordRef: 'm16-production-place',
    });
    const second: ThreadRuntimeTarget = {
      ...first,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 2,
    };
    const secondRequest = requestFor(second, '[m16-follow-up] 前の候補について教えて');
    const secondResult = await reopened.runRuntimeTurn({
      ...secondRequest,
      input: { ...secondRequest.input, excludeCandidateIds: [excludedCandidateId] },
    });
    expect(secondResult.status).toBe('completed');
    const afterSecond = await reopened.read(ownerScopeRef);
    if (!afterSecond.ok) throw new Error('reference restore fixture lost its thread binding');
    await expect(
      reopened.resolveCandidateForSavedReference(
        ownerScopeRef,
        excludedCandidateId,
        afterSecond.snapshot.revision,
      ),
    ).resolves.toEqual({ ok: false, code: 'UNKNOWN_CANDIDATE' });
    const restoredPayload = await readContextPayload(reopened);
    const restoredReference = v.safeParse(
      RuntimeProductionContextReferenceSchema,
      restoredPayload === null ? null : JSON.parse(restoredPayload),
    );
    expect(restoredReference.success).toBe(true);
    if (!restoredReference.success) throw new Error('restored context reference was invalid');
    expect(restoredReference.output.cardSet?.excludedCandidateIds).toContain(excludedCandidateId);
    await expect(reopened.getRuntimeProductionReport()).resolves.toMatchObject({
      modelHistorySeen: true,
      modelHistoryTextSeen: true,
      modelCardSetSeen: true,
    });
  });

  it('clears context, runtime commits, messages, and photo references on delete', async () => {
    const threadId = `m16-context-delete-${crypto.randomUUID()}`;
    const ownerScopeRef = `m16-context-owner-${crypto.randomUUID()}`;
    const namespace = productionEnv().PRODUCTION_THREADS;
    const first: ThreadRuntimeTarget = {
      ownerScopeRef,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = namespace.getByName(threadId);
    await expect(stub.initialize(ownerScopeRef, threadId)).resolves.toMatchObject({ ok: true });
    await expect(stub.runRuntimeTurn(requestFor(first))).resolves.toMatchObject({
      status: 'completed',
    });

    const record = {
      handle: 'h'.repeat(22),
      ownerScopeRef,
      threadId,
      deviceIdHash: 'd'.repeat(22),
      photoRef: 'places/ChIJfixture/photos/A1B2C3',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as const;
    await expect(
      stub.putPhotoReference(ownerScopeRef, record, new Date(0).toISOString()),
    ).resolves.toEqual({ ok: true });
    await expect(
      stub.getPhotoReference(
        ownerScopeRef,
        record.handle,
        record.deviceIdHash,
        new Date(0).toISOString(),
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(stub.deleteThread(ownerScopeRef, null, 2, `delete-${threadId}`)).resolves.toEqual({
      ok: true,
    });
    await expect(readRuntimeRows(stub)).resolves.toEqual({
      context: 0,
      commits: 0,
      messages: 0,
    });
    await expect(
      stub.getPhotoReference(
        ownerScopeRef,
        record.handle,
        record.deviceIdHash,
        new Date(0).toISOString(),
      ),
    ).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });
    await expect(
      stub.resolveCandidateForSavedReference(ownerScopeRef, 'deleted-candidate', 2),
    ).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });
    await expect(stub.listRuntimeResponses(ownerScopeRef)).resolves.toEqual([]);
  });

  it('denies admission after the fixed 05:00 JST expiry and performs cleanup once', async () => {
    const threadId = `m16-context-expired-${crypto.randomUUID()}`;
    const ownerScopeRef = `m16-context-owner-${crypto.randomUUID()}`;
    const namespace = productionEnv().PRODUCTION_THREADS;
    const first: ThreadRuntimeTarget = {
      ownerScopeRef,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = namespace.getByName(threadId);
    await expect(stub.initialize(ownerScopeRef, threadId)).resolves.toMatchObject({ ok: true });
    await expect(stub.runRuntimeTurn(requestFor(first))).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(readRuntimeRows(stub)).resolves.toMatchObject({ context: 1, commits: 1 });

    await expireAnchor(stub);
    await evictDurableObject(stub);
    const expired = namespace.getByName(threadId);
    const second: ThreadRuntimeTarget = {
      ...first,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 2,
    };
    await expect(expired.runRuntimeTurn(requestFor(second))).resolves.toMatchObject({
      status: 'failed',
      code: 'RUNTIME_FAILED',
      response: null,
    });
    await expect(expired.replayRuntimeTurn(first)).resolves.toEqual({
      status: 'unavailable',
      code: 'NOT_FOUND',
    });
    await expect(expired.listRuntimeResponses(ownerScopeRef)).resolves.toEqual([]);
    await expect(readRuntimeRows(expired)).resolves.toEqual({
      context: 0,
      commits: 0,
      messages: 0,
    });
    await expect(expired.runRuntimeTurn(requestFor(second))).resolves.toMatchObject({
      status: 'failed',
      code: 'RUNTIME_FAILED',
      response: null,
    });
    await expect(readRuntimeRows(expired)).resolves.toEqual({
      context: 0,
      commits: 0,
      messages: 0,
    });
  });
});
