import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { RuntimeGatePublicReport } from './runtime-gate-agent';

async function runFixture(
  scenario: string,
  parameters: Record<string, string> = {},
): Promise<RuntimeGatePublicReport> {
  const query = new URLSearchParams({ case: scenario, ...parameters });
  const response = await SELF.fetch(`https://ima.test/v1/runtime-gate?${query}`);
  expect(response.status).toBe(200);
  return await response.json();
}

async function runReplay(parameters: Record<string, string>): Promise<RuntimeGatePublicReport> {
  const query = new URLSearchParams(parameters);
  const response = await SELF.fetch(`https://ima.test/v1/runtime-gate/replay?${query}`);
  expect(response.status).toBe(200);
  return await response.json();
}

it('keeps the same candidate and field identity through details and submit', async () => {
  const report = await runFixture('sequence');

  expect(report.result?.status).toBe('completed');
  expect(report.toolAllowlist).toEqual(['search_places', 'get_place_details', 'submit_cards']);
  expect(report.model.requests[0]?.toolNames).toEqual([...report.toolAllowlist].sort());
  expect(report.toolExecutions.map((execution) => execution.name)).toEqual([
    'get_place_details',
    'submit_cards',
  ]);

  const details = report.core.calls.find((call) => call.operation === 'get_place_details');
  expect(details?.fields).toEqual(['identity', 'opening_hours']);
  expect(details?.observationIds).toEqual(['obs-identity-1', 'obs-opening-hours-1']);
  expect(report.core.calls.at(-1)?.evidenceIds).toEqual(['obs-identity-1']);
  expect(report.core.commits).toHaveLength(1);
});

it('repairs a missing-evidence submit through the SDK tool loop', async () => {
  const report = await runFixture('invalid');

  expect(report.result?.status).toBe('completed');
  expect(report.toolExecutions.map((execution) => execution.name)).toEqual([
    'submit_cards',
    'get_place_details',
    'submit_cards',
  ]);
  expect(report.core.calls[0]?.evidenceIds).toEqual([]);
  expect(report.core.calls[1]?.observationIds).toEqual(['obs-identity-1', 'obs-opening-hours-1']);
  expect(report.core.calls[2]?.evidenceIds).toEqual(['obs-identity-1']);
  expect(report.model.requests[1]?.sawMissingEvidence).toBe(true);
  expect(report.core.commits).toHaveLength(1);
});

it('buffers and validates a complete final step before exposing it to the SDK', async () => {
  const report = await runFixture('step-valid');

  expect(report.result?.status).toBe('completed');
  expect(report.model.calls).toBe(1);
  expect(report.step.bufferedSteps).toBe(1);
  expect(report.step.acceptedSteps).toHaveLength(1);
  expect(report.step.acceptedSteps[0]?.toolNames).toEqual([]);
  expect(report.step.rejectedSteps).toEqual([]);
  expect(report.toolExecutions).toEqual([]);
});

it('rejects unsafe complete provider steps before any Core tool execution', async () => {
  const expected = {
    'read-submit': 'M04_STEP_DENY_MIXED_READ_SUBMIT',
    'two-submit': 'M04_STEP_DENY_MULTIPLE_SUBMIT',
    'final-tool': 'M04_STEP_DENY_FINAL_WITH_TOOL',
    'final-tool-calls': 'M04_STEP_DENY_FINAL_WITH_TOOL',
    'constraints-missing': 'M04_STEP_DENY_TURN_CONSTRAINTS_MISSING',
    'constraints-changed': 'M04_STEP_DENY_TURN_CONSTRAINTS_CHANGED',
    'unknown-part': 'M04_STEP_DENY_UNSUPPORTED_PART',
  } as const;
  for (const [scenario, code] of Object.entries(expected)) {
    const report = await runFixture(scenario);
    expect(report.result?.status).toBe('error');
    expect(report.result?.error).toBe('UPSTREAM_UNAVAILABLE');
    expect(report.model.calls).toBe(1);
    expect(report.step.rejectedSteps).toEqual([code]);
    expect(report.toolExecutions).toEqual([]);
    expect(report.core.calls).toEqual([]);
    expect(report.core.commits).toEqual([]);
  }
});

it('keeps unknown tool calls and invalid known-tool arguments away from the Core Port', async () => {
  const unknown = await runFixture('unknown-tool');
  expect(unknown.result?.status).toBe('error');
  expect(unknown.step.rejectedSteps).toEqual(['M04_STEP_DENY_UNKNOWN_TOOL']);
  expect(unknown.toolExecutions).toEqual([]);
  expect(unknown.core.calls).toEqual([]);
  expect(unknown.model.requests[0]?.toolNames).toEqual([
    'get_place_details',
    'search_places',
    'submit_cards',
  ]);

  const invalid = await runFixture('invalid-arguments');
  expect(invalid.result?.status).toBe('completed');
  expect(invalid.toolExecutions).toEqual([]);
  expect(invalid.core.calls).toEqual([]);
  expect(invalid.model.requests).toHaveLength(2);
  for (const request of invalid.model.requests) {
    expect(request.toolNames).toEqual(['get_place_details', 'search_places', 'submit_cards']);
  }
});

it('replays a stored same-turn commit and rejects stale or conflicting requests before the SDK', async () => {
  const parameters = {
    idempotencyKey: 'runtime-gate-replay-key',
    content: 'same payload',
    turnId: 'turn-runtime-gate-replay',
    revision: '1',
  };
  const first = await runFixture('sequence', parameters);
  expect(first.result?.status).toBe('completed');
  expect(first.replay.outcome).toBe('stored');
  expect(first.replay.commit).not.toBeNull();

  const replay = await runReplay(parameters);
  expect(replay.result).toMatchObject({ status: 'completed', error: null });
  expect(replay.replay.outcome).toBe('replayed');
  expect(replay.replay.sameCommit).toBe(true);
  expect(replay.replay.commit).toEqual(first.replay.commit);
  expect(replay.nativeSdkStarted).toBe(false);
  expect(replay.model.calls).toBe(0);

  const stale = await runReplay({ ...parameters, revision: '0' });
  expect(stale.result).toMatchObject({ status: 'error', error: 'STALE_TURN' });
  expect(stale.replay.outcome).toBe('stale');
  expect(stale.replay.sameCommit).toBe(true);
  expect(stale.replay.commit).toEqual(first.replay.commit);
  expect(stale.nativeSdkStarted).toBe(false);
  expect(stale.model.calls).toBe(0);

  const conflict = await runReplay({ ...parameters, content: 'different payload' });
  expect(conflict.result).toMatchObject({
    status: 'error',
    error: 'IDEMPOTENCY_CONFLICT',
  });
  expect(conflict.replay.outcome).toBe('conflict');
  expect(conflict.nativeSdkStarted).toBe(false);
  expect(conflict.model.calls).toBe(0);
  expect(JSON.stringify(replay)).not.toContain(parameters.content);
});

it('sanitizes structured UI events before the chat response is persisted', async () => {
  const normal = await runFixture('structured');
  expect(normal.result?.status).toBe('completed');
  expect(normal.sse.events.length).toBeGreaterThan(0);
  expect(JSON.stringify(normal.sse.events)).not.toContain('M04_PROVIDER_FIELD_DENIED');
  expect(normal.sse.persistedMarkerPresent).toBe(false);

  const failed = await runFixture('structured-error');
  expect(failed.sse.persistedMarkerPresent).toBe(false);
  expect(JSON.stringify(failed.sse.events)).not.toContain('M04_PROVIDER_FIELD_DENIED');
});

it('stops repair attempts at the Core repair budget and handles final and HTTP boundaries', async () => {
  const repairs = await runFixture('repair-limit');
  expect(repairs.result?.status).toBe('completed');
  expect(repairs.model.calls).toBe(3);
  expect(repairs.toolExecutions).toHaveLength(3);
  expect(repairs.core.repairCount).toBe(3);
  expect(repairs.core.commits).toEqual([]);

  const empty = await runFixture('empty-final');
  expect(empty.result?.status).toBe('completed');
  expect(empty.model.calls).toBe(1);
  expect(empty.core.commits).toHaveLength(1);
  expect(empty.step.acceptedSteps[0]?.toolNames).toEqual(['submit_cards']);

  const timeout = await runFixture('timeout');
  expect(timeout.result?.status).toBe('error');
  expect(timeout.step.rejectedSteps).toEqual(['M04_STEP_DENY_TIMEOUT']);
  expect(timeout.toolExecutions).toEqual([]);
  expect(timeout.core.commits).toEqual([]);

  const notFound = await SELF.fetch('https://ima.test/v1/runtime-gate', { method: 'POST' });
  expect(notFound.status).toBe(404);
});

it('propagates an external cancellation signal through the SDK tool options', async () => {
  const report = await runFixture('cancel');
  expect(report.result?.status).toBe('aborted');
  expect(report.toolExecutions[0]?.abortSignalPassed).toBe(true);
  expect(report.core.commits).toEqual([]);
  expect(report.core.calls).toEqual([]);
});
