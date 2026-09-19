import { env, runInDurableObject } from 'cloudflare:test';
import type { AssistantResponse } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import type { ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
  ThreadRuntimeTurnResult,
} from '@worker/runtime/threads/admission';
import { runtimeFailure } from '@worker/runtime/threads/admission';
import { persistRuntimeResult } from '@worker/adapters/out/persistence/thread/result-persistence';

const OWNER_A = 'A'.repeat(42) + 'E';
const OWNER_B = 'B'.repeat(42) + 'E';

type TestEnv = Cloudflare.Env & { THREADS: DurableObjectNamespace<ThreadDO> };

function hasThreadBinding(value: typeof env): value is TestEnv {
  return typeof value === 'object' && value !== null && 'THREADS' in value;
}

function testEnv(value: typeof env): TestEnv {
  if (!hasThreadBinding(value)) throw new Error('M10_THREAD_BINDING_MISSING');
  return value;
}

function runtimeInput(target: ThreadRuntimeTarget, text = '静かな店'): ThreadRuntimeTurnInput {
  return {
    ...target,
    idempotencyKey: `runtime-${target.turnId}`,
    input: {
      schemaVersion: 'v1',
      requestId: `request-${target.turnId}`,
      turnId: target.turnId,
      revision: target.revision,
      text,
      clientNow: '2026-09-10T12:00:00Z',
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
        maxWalkMinutes: 15,
        minimumStayMinutes: null,
        areaText: '恵比寿',
        budget: 'normal',
      },
      savedPlaceRefs: [],
      excludeCandidateIds: [],
      mode: 'search',
      idempotencyKey: `runtime-${target.turnId}`,
    },
  };
}

const completedResponse = (target: ThreadRuntimeTarget): AssistantResponse => ({
  schemaVersion: 'v1',
  threadId: target.threadId,
  turnId: target.turnId,
  responseId: `response-${target.turnId}`,
  revision: target.revision + 1,
  kind: 'message',
  presentation: 'keep',
  cardSetId: null,
  message: [
    {
      text: '確認しました',
      evidenceIds: [],
      evidence: [],
      basis: 'conversational',
      retention: {
        retentionDecision: 'deny',
        retentionMode: 'session_only',
        sessionExpiresAt: '2026-09-10T16:00:00Z',
        freshUntil: null,
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
        attribution: null,
        restoreMode: 'reference_only',
        policyStatus: 'policy_withheld',
        displayPolicyStatus: 'policy_withheld',
      },
    },
  ],
});

async function seedRunningRow(
  stub: DurableObjectStub<ThreadDO>,
  target: ThreadRuntimeTarget,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      'INSERT INTO runtime_turn (turn_id, owner_scope_ref, thread_id, revision, idempotency_key, input_digest, status, request_id, response_id, response_revision, response_kind, response_presentation, response_card_set_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      target.turnId,
      target.ownerScopeRef,
      target.threadId,
      target.revision,
      `seed-${target.turnId}`,
      'seed-digest',
      'running',
      'seed-request',
      null,
      null,
      null,
      null,
      null,
    );
  });
}

type RuntimeStatusRow = {
  readonly status: string;
  readonly response_id: string | null;
  readonly response_revision: number | null;
};

type ThreadRevisionRow = { readonly revision: number };

describe('ThreadDO runtime admission', () => {
  it('fails explicitly when runtime composition is not configured and rejects changed content', async () => {
    const threadId = `runtime-unconfigured-${crypto.randomUUID()}`;
    const stub = testEnv(env).THREADS.getByName(threadId);
    expect(await stub.initialize(OWNER_A, threadId)).toMatchObject({ ok: true });
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: OWNER_A,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const input = runtimeInput(target);

    await expect(stub.runRuntimeTurn(input)).resolves.toMatchObject({
      status: 'failed',
      code: 'RUNTIME_UNCONFIGURED',
    });
    await expect(
      stub.runRuntimeTurn({
        ...input,
        input: { ...input.input, requestId: `retry-${crypto.randomUUID()}` },
      }),
    ).resolves.toMatchObject({ status: 'failed', code: 'RUNTIME_FAILED' });
    await expect(
      stub.runRuntimeTurn({
        ...input,
        input: { ...input.input, text: '別の内容' },
      }),
    ).resolves.toMatchObject({ status: 'failed', code: 'IDEMPOTENCY_CONFLICT' });

    await expect(stub.listRuntimeResponses(OWNER_B)).resolves.toEqual([]);
    await expect(stub.listRuntimeResponses(OWNER_A)).resolves.toEqual([
      expect.objectContaining({
        turnId: target.turnId,
        revision: target.revision,
        status: 'failed',
        responseId: null,
        kind: null,
        presentation: null,
        cardSetId: null,
      }),
    ]);
  });

  it('records pre-admission cancellation and keeps the owner tombstone after deletion', async () => {
    const threadId = `runtime-cancel-${crypto.randomUUID()}`;
    const stub = testEnv(env).THREADS.getByName(threadId);
    expect(await stub.initialize(OWNER_A, threadId)).toMatchObject({ ok: true });
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: OWNER_A,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };

    await expect(stub.cancelRuntimeTurn(target)).resolves.toEqual({ status: 'accepted' });
    await expect(stub.runRuntimeTurn(runtimeInput(target))).resolves.toMatchObject({
      status: 'cancelled',
      code: 'CANCELLED',
    });
    await expect(stub.cancelRuntimeTurn({ ...target, ownerScopeRef: OWNER_B })).resolves.toEqual({
      status: 'rejected',
      code: 'NOT_FOUND',
    });

    expect(await stub.deleteThread(OWNER_A, null, 1, `delete-${crypto.randomUUID()}`)).toEqual({
      ok: true,
    });
    await expect(stub.listRuntimeResponses(OWNER_A)).resolves.toEqual([]);
    await expect(stub.replayRuntimeTurn(target)).resolves.toEqual({
      status: 'unavailable',
      code: 'NOT_FOUND',
    });
  });

  it('does not commit or return a body when completion arrives after cancellation', async () => {
    const threadId = `runtime-late-completion-${crypto.randomUUID()}`;
    const stub = testEnv(env).THREADS.getByName(threadId);
    expect(await stub.initialize(OWNER_A, threadId)).toMatchObject({ ok: true });
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: OWNER_A,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    await seedRunningRow(stub, target);
    await expect(stub.cancelRuntimeTurn(target)).resolves.toEqual({ status: 'accepted' });

    const late: ThreadRuntimeTurnResult = {
      status: 'completed',
      requestId: 'late-request',
      response: completedResponse(target),
    };
    const observed = await runInDurableObject(stub, (_instance, state) => {
      let commitCalls = 0;
      const result = persistRuntimeResult({
        storage: state.storage,
        target,
        result: late,
        commitResponse: () => {
          commitCalls += 1;
          return true;
        },
      });
      const runtime = state.storage.sql
        .exec<RuntimeStatusRow>(
          'SELECT status, response_id, response_revision FROM runtime_turn WHERE thread_id = ? AND turn_id = ? AND revision = ?',
          target.threadId,
          target.turnId,
          target.revision,
        )
        .toArray()[0];
      const thread = state.storage.sql
        .exec<ThreadRevisionRow>('SELECT revision FROM thread_state WHERE singleton = 1')
        .toArray()[0];
      return {
        result,
        commitCalls,
        runtime: runtime ?? null,
        threadRevision: thread?.revision ?? null,
      };
    });

    expect(observed.result).toEqual(runtimeFailure('CANCELLED', 'late-request'));
    expect(observed.commitCalls).toBe(0);
    expect(observed.runtime).toEqual({
      status: 'cancelled',
      response_id: null,
      response_revision: null,
    });
    expect(observed.threadRevision).toBe(1);
  });

  it('marks an admitted runtime turn cancelled when lifecycle advances the revision', async () => {
    const threadId = `runtime-lifecycle-cancel-${crypto.randomUUID()}`;
    const stub = testEnv(env).THREADS.getByName(threadId);
    await expect(stub.initialize(OWNER_A, threadId)).resolves.toMatchObject({ ok: true });
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: OWNER_A,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    await seedRunningRow(stub, target);

    await expect(
      stub.applyLifecycle(OWNER_A, 'cancelled', target.turnId, target.revision, 'cancel-key'),
    ).resolves.toMatchObject({ ok: true });

    const status = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<RuntimeStatusRow>(
            'SELECT status, response_id, response_revision FROM runtime_turn WHERE thread_id = ? AND turn_id = ? AND revision = ?',
            target.threadId,
            target.turnId,
            target.revision,
          )
          .toArray()[0],
    );
    expect(status).toMatchObject({ status: 'cancel_requested' });
  });

  it('keeps a known runtime failure code in the SQL ledger result', async () => {
    const threadId = `runtime-failure-code-${crypto.randomUUID()}`;
    const stub = testEnv(env).THREADS.getByName(threadId);
    expect(await stub.initialize(OWNER_A, threadId)).toMatchObject({ ok: true });
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: OWNER_A,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    await seedRunningRow(stub, target);

    const observed = await runInDurableObject(stub, (_instance, state) => {
      const result = persistRuntimeResult({
        storage: state.storage,
        target,
        result: runtimeFailure('RUNTIME_UNCONFIGURED', 'unconfigured-request'),
      });
      const runtime = state.storage.sql
        .exec<RuntimeStatusRow>(
          'SELECT status, response_id, response_revision FROM runtime_turn WHERE thread_id = ? AND turn_id = ? AND revision = ?',
          target.threadId,
          target.turnId,
          target.revision,
        )
        .toArray()[0];
      return { result, runtime: runtime ?? null };
    });

    expect(observed.result).toEqual(runtimeFailure('RUNTIME_UNCONFIGURED', 'unconfigured-request'));
    expect(observed.runtime).toEqual({
      status: 'failed',
      response_id: null,
      response_revision: null,
    });
  });
});
