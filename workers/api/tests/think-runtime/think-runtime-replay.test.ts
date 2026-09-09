import { expect, it } from 'vitest';
import { parseThreadSnapshot } from '@ima/contracts';
import {
  resolveThinkRuntimeReplay,
  sha256Hex,
  storeThinkRuntimeReplay,
  type ThinkRuntimeReplayRecord,
  type ThinkRuntimeState,
} from './think-runtime-replay';
import { normalizeThinkRuntimeReplayReport } from './think-runtime-replay-http';

const payload = 'provider quote must not be copied into the replay record';
const replayInput = {
  idempotencyKey: 'replay-key',
  payload,
  turnId: 'turn-replay',
  revision: 2,
  responseId: 'response-replay-1',
  candidateIds: ['candidate-1'],
  evidenceIds: ['obs-identity-1'],
};

async function storedRecord(): Promise<ThinkRuntimeReplayRecord> {
  let state: ThinkRuntimeState | undefined;
  await storeThinkRuntimeReplay(replayInput, (next) => {
    state = next;
  });
  if (state?.replay === undefined) throw new Error('replay record was not stored');
  return state.replay;
}

function replayUrl(parameters: Record<string, string>): URL {
  return new URL(`https://ima.test/replay?${new URLSearchParams(parameters)}`);
}

it('stores only the payload digest and returns a stable commit reference', async () => {
  let state: ThinkRuntimeState | undefined;
  const report = await storeThinkRuntimeReplay(replayInput, (next) => {
    state = next;
  });

  expect(report).toMatchObject({ action: 'run', outcome: 'stored', sameCommit: false });
  expect(state?.replay?.payloadDigest).toBe(await sha256Hex(payload));
  expect(JSON.stringify(state)).not.toContain(payload);
  expect(state?.replay?.commit).toEqual({
    responseId: replayInput.responseId,
    revision: replayInput.revision,
    candidateIds: replayInput.candidateIds,
    evidenceIds: replayInput.evidenceIds,
  });
});

it('distinguishes exact replay, payload conflict, stale revision, and missing records', async () => {
  const record = await storedRecord();
  const exact = await resolveThinkRuntimeReplay(
    replayUrl({
      idempotencyKey: replayInput.idempotencyKey,
      content: payload,
      turnId: replayInput.turnId,
      revision: String(replayInput.revision),
    }),
    record,
    1,
  );
  expect(exact.report).toMatchObject({
    outcome: 'replayed',
    sameCommit: true,
    commit: record.commit,
  });
  expect(exact.result).toMatchObject({ status: 'completed', error: null });

  const conflict = await resolveThinkRuntimeReplay(
    replayUrl({
      idempotencyKey: replayInput.idempotencyKey,
      content: `${payload}-changed`,
      turnId: replayInput.turnId,
      revision: String(replayInput.revision),
    }),
    record,
    2,
  );
  expect(conflict.report.outcome).toBe('conflict');
  expect(conflict.result).toMatchObject({ status: 'error', error: 'IDEMPOTENCY_CONFLICT' });
  expect(JSON.stringify(conflict)).not.toContain(`${payload}-changed`);

  const stale = await resolveThinkRuntimeReplay(
    replayUrl({
      idempotencyKey: replayInput.idempotencyKey,
      content: payload,
      turnId: replayInput.turnId,
      revision: '1',
    }),
    record,
    3,
  );
  expect(stale.report.outcome).toBe('stale');
  expect(stale.result).toMatchObject({ status: 'error', error: 'STALE_TURN' });

  const missing = await resolveThinkRuntimeReplay(
    replayUrl({
      idempotencyKey: replayInput.idempotencyKey,
      content: payload,
      turnId: replayInput.turnId,
      revision: String(replayInput.revision),
    }),
    undefined,
    4,
  );
  expect(missing.report.outcome).toBe('missing');
  expect(missing.result).toMatchObject({ status: 'error', error: 'IDEMPOTENCY_MISSING' });
});

it('converts a successful replay to a reference-only ThreadReadResponse', () => {
  const report = {
    nativeSdkStarted: false,
    result: { requestId: 'request-replay-1', status: 'completed', error: null },
    model: { calls: 0 },
    core: { commits: [] },
    replay: {
      action: 'replay',
      outcome: 'replayed',
      idempotencyKey: replayInput.idempotencyKey,
      turnId: replayInput.turnId,
      requestedRevision: replayInput.revision,
      storedRevision: replayInput.revision,
      commit: {
        responseId: replayInput.responseId,
        revision: replayInput.revision,
        candidateIds: replayInput.candidateIds,
        evidenceIds: replayInput.evidenceIds,
      },
      sameCommit: true,
    },
    content: payload,
  };
  const snapshot = normalizeThinkRuntimeReplayReport(report, {
    threadId: 'thread-replay',
    turnId: replayInput.turnId,
    revision: replayInput.revision,
  });
  const parsed = parseThreadSnapshot(snapshot);
  expect(parsed.success).toBe(true);
  expect(snapshot.responses).toEqual([
    {
      turnId: replayInput.turnId,
      responseId: replayInput.responseId,
      revision: replayInput.revision,
      kind: 'cards',
      presentation: 'replace',
      cardSetId: `cards-${replayInput.responseId}`,
      restoreMode: 'reference_only',
    },
  ]);
  expect(JSON.stringify(snapshot)).not.toContain(payload);
});

it('rejects replay conversion when the report indicates SDK work', () => {
  const report = {
    nativeSdkStarted: true,
    result: { requestId: 'request-replay-1', status: 'completed', error: null },
    model: { calls: 1 },
    core: { commits: [] },
    replay: {
      action: 'replay',
      outcome: 'replayed',
      turnId: replayInput.turnId,
      requestedRevision: replayInput.revision,
      storedRevision: replayInput.revision,
      commit: {
        responseId: replayInput.responseId,
        revision: replayInput.revision,
        candidateIds: replayInput.candidateIds,
        evidenceIds: replayInput.evidenceIds,
      },
      sameCommit: true,
    },
  };
  expect(() =>
    normalizeThinkRuntimeReplayReport(report, {
      threadId: 'thread-replay',
      turnId: replayInput.turnId,
      revision: replayInput.revision,
    }),
  ).toThrow('FIXTURE_REPLAY_NOT_AVAILABLE');
});
