import { env, runInDurableObject } from 'cloudflare:test';
import type { AssistantResponse } from '@ima/contracts';
import type { CommitRequest, CommitPortResult } from '@ima/core';
import { describe, expect, it } from 'vitest';
import { createDurableCommitPort } from '@api/thread-runtime/commit-port';
import { persistRuntimeResult } from '@api/thread-runtime/result-persistence';
import type { ThreadDO } from '@api/thread-do';
import type { ThreadRuntimeTarget } from '@api/thread-runtime/admission';

type TestEnv = Cloudflare.Env & { THREADS: DurableObjectNamespace<ThreadDO> };

const hasThreadBinding = (value: typeof env): value is TestEnv =>
  typeof value === 'object' && value !== null && 'THREADS' in value;

const testEnv = (value: typeof env): TestEnv => {
  if (!hasThreadBinding(value)) throw new Error('M16_THREAD_BINDING_MISSING');
  return value;
};

const targetFor = (threadId: string): ThreadRuntimeTarget => ({
  ownerScopeRef: `m16-owner-${crypto.randomUUID()}`,
  threadId,
  turnId: `m16-turn-${crypto.randomUUID()}`,
  revision: 1,
});

const commitFor = (target: ThreadRuntimeTarget, suffix = ''): CommitRequest => ({
  expectedRevision: target.revision,
  record: {
    schemaVersion: 'v1',
    scope: { ownerScopeRef: target.ownerScopeRef, threadId: target.threadId },
    turnId: target.turnId,
    idempotencyKey: `m16-commit-${target.turnId}`,
    responseId: `m16-response-${target.turnId}${suffix}`,
    revision: target.revision + 1,
    payloadDigest: `m16-digest-${target.turnId}`,
    presentation: 'replace',
    references: {
      candidateIds: [`m16-candidate-${target.turnId}`],
      observationIds: [`m16-observation-${target.turnId}`],
    },
  },
});

const messageCommitFor = (target: ThreadRuntimeTarget): CommitRequest => ({
  expectedRevision: target.revision,
  record: {
    schemaVersion: 'v1',
    scope: { ownerScopeRef: target.ownerScopeRef, threadId: target.threadId },
    turnId: target.turnId,
    idempotencyKey: `m16-message-${target.turnId}`,
    responseId: `m16-message-response-${target.turnId}`,
    revision: target.revision + 1,
    payloadDigest: `m16-message-digest-${target.turnId}`,
    presentation: 'keep',
    references: { candidateIds: [], observationIds: [] },
  },
});

const cardResponseFor = (
  target: ThreadRuntimeTarget,
  changes: Partial<Pick<AssistantResponse, 'responseId' | 'revision' | 'cardSetId'>> = {},
): AssistantResponse => ({
  schemaVersion: 'v1',
  threadId: target.threadId,
  turnId: target.turnId,
  responseId: changes.responseId ?? `m16-response-${target.turnId}`,
  revision: changes.revision ?? target.revision + 1,
  kind: 'cards',
  presentation: 'replace',
  cardSetId: changes.cardSetId ?? `m16-card-set-${target.turnId}`,
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
  cards: {
    hero: {
      candidateId: `m16-candidate-${target.turnId}`,
      facts: { identity: { status: 'unknown', reason: 'fixture' } },
      why: {
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
    },
    alts: [],
  },
});

const durableCommit = (
  port: ReturnType<typeof createDurableCommitPort>,
  request: CommitRequest,
): ReturnType<typeof port.commit> => {
  if (request.record.presentation === 'replace') {
    port.setCardSetId(
      request.record.scope,
      request.record.idempotencyKey,
      `m16-card-set-${request.record.turnId}`,
    );
  }
  return port.commit(request);
};

const seedRuntimeRow = async (
  stub: DurableObjectStub<ThreadDO>,
  target: ThreadRuntimeTarget,
  status: 'running' | 'cancel_requested' = 'running',
): Promise<void> => {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      'INSERT INTO runtime_turn (turn_id, owner_scope_ref, thread_id, revision, idempotency_key, input_digest, status, request_id, response_id, response_revision, response_kind, response_presentation, response_card_set_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      target.turnId,
      target.ownerScopeRef,
      target.threadId,
      target.revision,
      `m16-runtime-${target.turnId}`,
      'm16-input-digest',
      status,
      null,
      null,
      null,
      null,
      null,
      null,
    );
  });
};

describe('M16 Durable CommitPort', () => {
  it('CASes the thread, finalizes runtime metadata, and replays one reference ledger row', async () => {
    const threadId = `m16-commit-${crypto.randomUUID()}`;
    const target = targetFor(threadId);
    const stub = testEnv(env).THREADS.getByName(threadId);
    await expect(stub.initialize(target.ownerScopeRef, threadId)).resolves.toMatchObject({
      ok: true,
    });
    await seedRuntimeRow(stub, target);

    const observed = await runInDurableObject(stub, (_instance, state) => {
      const port = createDurableCommitPort(state.storage);
      const first = durableCommit(port, commitFor(target));
      const replay = port.commit(commitFor(target));
      const thread = state.storage.sql
        .exec<{ readonly revision: number }>(
          'SELECT revision FROM thread_state WHERE singleton = 1',
        )
        .toArray()[0];
      const runtime = state.storage.sql
        .exec<{
          readonly status: string;
          readonly response_id: string | null;
          readonly response_revision: number | null;
          readonly response_card_set_id: string | null;
        }>(
          'SELECT status, response_id, response_revision, response_card_set_id FROM runtime_turn WHERE thread_id = ? AND turn_id = ? AND revision = ?',
          target.threadId,
          target.turnId,
          target.revision,
        )
        .toArray()[0];
      const ledger = state.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM runtime_commit')
        .toArray()[0];
      return { first, replay, thread, runtime, ledger };
    });

    expect(observed.first).toMatchObject({
      status: 'committed',
      receipt: { responseId: commitFor(target).record.responseId, revision: 2, replayed: false },
    });
    expect(observed.replay).toMatchObject({
      status: 'committed',
      receipt: { responseId: commitFor(target).record.responseId, revision: 2, replayed: true },
    });
    expect(observed.thread?.revision).toBe(2);
    expect(observed.runtime).toEqual({
      status: 'completed',
      response_id: commitFor(target).record.responseId,
      response_revision: 2,
      response_card_set_id: `m16-card-set-${target.turnId}`,
    });
    expect(observed.ledger?.count).toBe(1);
  });

  it('requires a running runtime row and the exact next revision before any write', async () => {
    const threadId = `m16-commit-gate-${crypto.randomUUID()}`;
    const target = targetFor(threadId);
    const stub = testEnv(env).THREADS.getByName(threadId);
    await expect(stub.initialize(target.ownerScopeRef, threadId)).resolves.toMatchObject({
      ok: true,
    });

    const observed = await runInDurableObject(stub, async (_instance, state) => {
      const port = createDurableCommitPort(state.storage);
      const missingRuntime = durableCommit(port, commitFor(target));
      let invalidRevisionError: string | null = null;
      {
        const request = commitFor(target);
        try {
          await Promise.resolve(
            durableCommit(port, {
              ...request,
              record: { ...request.record, revision: target.revision + 2 },
            }),
          );
        } catch (error: unknown) {
          invalidRevisionError = error instanceof Error ? error.message : 'unknown';
        }
      }
      const thread = state.storage.sql
        .exec<{ readonly revision: number }>(
          'SELECT revision FROM thread_state WHERE singleton = 1',
        )
        .toArray()[0];
      const commits = state.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM runtime_commit')
        .toArray()[0];
      return { missingRuntime, invalidRevisionError, thread, commits };
    });

    expect(observed.missingRuntime).toEqual({
      status: 'conflict',
      conflict: { code: 'STALE_REVISION', message: 'commit revision is no longer current' },
    });
    expect(observed.invalidRevisionError).toBe(
      'commit revision does not advance expected revision',
    );
    expect(observed.thread?.revision).toBe(1);
    expect(observed.commits?.count).toBe(0);
  });

  it('finalizes a reference-only message without a card-set sidecar', async () => {
    const threadId = `m16-message-${crypto.randomUUID()}`;
    const target = targetFor(threadId);
    const stub = testEnv(env).THREADS.getByName(threadId);
    await expect(stub.initialize(target.ownerScopeRef, threadId)).resolves.toMatchObject({
      ok: true,
    });
    await seedRuntimeRow(stub, target);

    const result = await runInDurableObject(stub, (_instance, state) =>
      durableCommit(createDurableCommitPort(state.storage), messageCommitFor(target)),
    );
    expect(result).toMatchObject({
      status: 'committed',
      receipt: {
        responseId: `m16-message-response-${target.turnId}`,
        revision: 2,
        presentation: 'keep',
        replayed: false,
      },
    });

    const row = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{
            readonly status: string;
            readonly response_kind: string | null;
            readonly response_card_set_id: string | null;
          }>(
            'SELECT status, response_kind, response_card_set_id FROM runtime_turn WHERE thread_id = ? AND turn_id = ? AND revision = ?',
            target.threadId,
            target.turnId,
            target.revision,
          )
          .toArray()[0],
    );
    expect(row).toEqual({
      status: 'completed',
      response_kind: 'message',
      response_card_set_id: null,
    });
  });

  it('blocks an idempotent replay after the owning thread is deleted', async () => {
    const threadId = `m16-commit-delete-${crypto.randomUUID()}`;
    const target = targetFor(threadId);
    const stub = testEnv(env).THREADS.getByName(threadId);
    await expect(stub.initialize(target.ownerScopeRef, threadId)).resolves.toMatchObject({
      ok: true,
    });
    await seedRuntimeRow(stub, target);
    const first = await runInDurableObject(stub, (_instance, state) =>
      durableCommit(createDurableCommitPort(state.storage), commitFor(target)),
    );
    const firstResult = first;
    expect(firstResult).toMatchObject({ status: 'committed' });
    await expect(
      stub.deleteThread(target.ownerScopeRef, null, 2, `delete-${threadId}`),
    ).resolves.toEqual({
      ok: true,
    });
    const ledgerAfterDelete = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM runtime_commit')
          .toArray()[0],
    );
    expect(ledgerAfterDelete?.count).toBe(0);

    const replay = await runInDurableObject(stub, (_instance, state) =>
      durableCommit(createDurableCommitPort(state.storage), commitFor(target)),
    );
    const replayResult = replay;
    expect(replayResult).toEqual({
      status: 'conflict',
      conflict: { code: 'STALE_REVISION', message: 'commit revision is no longer current' },
    });
  });

  it('rejects completed metadata mismatches without changing the receipt or ledger', async () => {
    const threadId = `m16-commit-metadata-${crypto.randomUUID()}`;
    const target = targetFor(threadId);
    const stub = testEnv(env).THREADS.getByName(threadId);
    await expect(stub.initialize(target.ownerScopeRef, threadId)).resolves.toMatchObject({
      ok: true,
    });
    await seedRuntimeRow(stub, target);
    await runInDurableObject(stub, (_instance, state) =>
      durableCommit(createDurableCommitPort(state.storage), commitFor(target)),
    );

    const observed = await runInDurableObject(stub, (_instance, state) => {
      const base = (response: AssistantResponse, requestId: string) =>
        persistRuntimeResult({
          storage: state.storage,
          target,
          result: { status: 'completed', requestId, response },
        });
      const responseMismatch = base(
        cardResponseFor(target, { responseId: `m16-other-response-${target.turnId}` }),
        'm16-mismatch-response',
      );
      const revisionMismatch = base(
        cardResponseFor(target, { revision: target.revision + 2 }),
        'm16-mismatch-revision',
      );
      const cardSetMismatch = base(
        cardResponseFor(target, { cardSetId: `m16-other-card-set-${target.turnId}` }),
        'm16-mismatch-card-set',
      );
      const runtime = state.storage.sql
        .exec<{
          readonly status: string;
          readonly response_id: string | null;
          readonly response_revision: number | null;
          readonly response_card_set_id: string | null;
        }>(
          'SELECT status, response_id, response_revision, response_card_set_id FROM runtime_turn WHERE thread_id = ? AND turn_id = ? AND revision = ?',
          target.threadId,
          target.turnId,
          target.revision,
        )
        .toArray()[0];
      const ledger = state.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM runtime_commit')
        .toArray()[0];
      return { responseMismatch, revisionMismatch, cardSetMismatch, runtime, ledger };
    });

    expect(observed.responseMismatch).toMatchObject({
      status: 'stale',
      code: 'STALE_TURN',
      response: null,
    });
    expect(observed.revisionMismatch).toMatchObject({
      status: 'failed',
      code: 'RUNTIME_FAILED',
      response: null,
    });
    expect(observed.cardSetMismatch).toMatchObject({
      status: 'stale',
      code: 'STALE_TURN',
      response: null,
    });
    expect(observed.runtime).toEqual({
      status: 'completed',
      response_id: commitFor(target).record.responseId,
      response_revision: 2,
      response_card_set_id: `m16-card-set-${target.turnId}`,
    });
    expect(observed.ledger?.count).toBe(1);
  });

  it('rejects changed idempotent content and stale CAS without adding rows', async () => {
    const threadId = `m16-stale-${crypto.randomUUID()}`;
    const target = targetFor(threadId);
    const stub = testEnv(env).THREADS.getByName(threadId);
    await expect(stub.initialize(target.ownerScopeRef, threadId)).resolves.toMatchObject({
      ok: true,
    });
    await seedRuntimeRow(stub, target);

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const port = createDurableCommitPort(state.storage);
      const first = await durableCommit(port, commitFor(target));
      const changed = await durableCommit(port, {
        ...commitFor(target),
        record: { ...commitFor(target).record, payloadDigest: 'm16-different-digest' },
      });
      const stale = await durableCommit(port, {
        ...commitFor(target),
        expectedRevision: 2,
        record: { ...commitFor(target).record, idempotencyKey: 'm16-stale-key', revision: 3 },
      });
      const rows = state.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM runtime_commit')
        .toArray()[0];
      return { first, changed, stale, rows };
    });

    expect(result.first).toMatchObject({ status: 'committed' });
    expect(result.changed).toEqual({
      status: 'conflict',
      conflict: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'commit idempotency key has different content',
      },
    });
    expect(result.stale).toEqual({
      status: 'conflict',
      conflict: { code: 'STALE_REVISION', message: 'commit revision is no longer current' },
    });
    expect(result.rows?.count).toBe(1);
  });

  it('does not commit a runtime row already marked for cancellation', async () => {
    const threadId = `m16-cancel-${crypto.randomUUID()}`;
    const target = targetFor(threadId);
    const stub = testEnv(env).THREADS.getByName(threadId);
    await expect(stub.initialize(target.ownerScopeRef, threadId)).resolves.toMatchObject({
      ok: true,
    });
    await seedRuntimeRow(stub, target, 'cancel_requested');

    const result = await runInDurableObject(stub, (_instance, state) => {
      const port = createDurableCommitPort(state.storage);
      const commit = durableCommit(port, commitFor(target));
      const thread = state.storage.sql
        .exec<{ readonly revision: number }>(
          'SELECT revision FROM thread_state WHERE singleton = 1',
        )
        .toArray()[0];
      const rows = state.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM runtime_commit')
        .toArray()[0];
      return { commit, thread, rows };
    });

    const expected: CommitPortResult = {
      status: 'conflict',
      conflict: { code: 'STALE_REVISION', message: 'commit revision is no longer current' },
    };
    expect(result.commit).toEqual(expected);
    expect(result.thread?.revision).toBe(1);
    expect(result.rows?.count).toBe(0);
  });
});
