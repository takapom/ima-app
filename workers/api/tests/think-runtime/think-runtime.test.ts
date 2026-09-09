import { env, evictDurableObject, SELF } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { ThinkRuntimeGateAgent, ThinkRuntimePublicReport } from './think-runtime-agent';
import type { ThinkRuntimeTableObservation } from './think-runtime-audit';
import { STALE_NATIVE_CONTENT_CANARY } from '../runtime-gate/runtime-gate-provider';

const NATIVE_CONTENT_AGENT = `think-native-content-${crypto.randomUUID()}`;

type ThinkRuntimeTestEnv = Cloudflare.Env & {
  THINK_RUNTIME: DurableObjectNamespace<ThinkRuntimeGateAgent>;
};

function hasThinkRuntime(value: unknown): value is ThinkRuntimeTestEnv {
  return typeof value === 'object' && value !== null && 'THINK_RUNTIME' in value;
}

async function runFixture(
  scenario: string,
  parameters: Record<string, string> = {},
): Promise<ThinkRuntimePublicReport> {
  const query = new URLSearchParams({ case: scenario, ...parameters });
  const response = await SELF.fetch(`https://ima.test/v1/think-runtime?${query}`);
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return body as ThinkRuntimePublicReport;
}

function expectObservedStorageWithoutMarker(
  storage: Record<string, ThinkRuntimeTableObservation>,
): void {
  for (const requiredTable of ['assistant_messages', 'cf_ai_chat_stream_chunks'] as const) {
    const observation = storage[requiredTable];
    if (observation === undefined) throw new Error(`missing storage table: ${requiredTable}`);
    expect(observation.observed).toBe(true);
    expect(observation.readError).toBe(null);
    expect(observation.markerCount).toBe(0);
  }
  for (const [table, observation] of Object.entries(storage)) {
    expect(observation.markerCount).toBe(0);
    if (observation.observed) {
      expect(observation.readError).toBe(null);
    } else {
      expect(['_cf_KV', '_cf_METADATA']).toContain(table);
      expect(observation.readError).toBeTruthy();
    }
  }
}

function expectNoPersistedMarker(report: ThinkRuntimePublicReport): void {
  expect(report.persistence.liveCacheMarkerPresent).toBe(false);
  expect(report.persistence.sessionHistoryMarkerPresent).toBe(false);
  expectObservedStorageWithoutMarker(report.persistence.storageMarkerCounts);
}

function expectNoPersistedCanary(report: ThinkRuntimePublicReport): void {
  expect(report.canary).not.toBeNull();
  if (report.canary === null) return;
  expect(report.canary.liveCacheMarkerPresent).toBe(false);
  expect(report.canary.sessionHistoryMarkerPresent).toBe(false);
  expectObservedStorageWithoutMarker(report.canary.storageMarkerCounts);
}

function expectNoLoggedCanary(report: ThinkRuntimePublicReport, canary: string): void {
  expect(report.logEntries.length).toBeGreaterThan(0);
  expect(JSON.stringify(report.logEntries)).not.toContain(canary);
}

async function evictNativeContentAgent(): Promise<void> {
  if (!hasThinkRuntime(env)) throw new Error('THINK_RUNTIME_BINDING_MISSING');
  await evictDurableObject(env.THINK_RUNTIME.getByName(NATIVE_CONTENT_AGENT));
}

it('runs Think native loop through Core details and commit with a persistent transform', async () => {
  const report = await runFixture('sequence');

  expect(report.result?.status).toBe('completed');
  expect(report.nativeSdkStarted).toBe(true);
  expect(report.toolAllowlist).toEqual(['search_places', 'get_place_details', 'submit_cards']);
  expect(report.model.requests[0]?.toolNames).toEqual([...report.toolAllowlist].sort());
  expect(report.toolExecutions.map((execution) => execution.name)).toEqual([
    'get_place_details',
    'submit_cards',
  ]);
  expect(report.core.calls.at(-1)?.evidenceIds).toEqual(['obs-identity-1']);
  expect(report.core.commits).toHaveLength(1);
  expect(report.core.portCalls.map((call) => call.operation)).toEqual([
    'get_place_details',
    'submit_cards',
  ]);
  expect(report.core.portCalls.every((call) => call.cancelled === false)).toBe(true);
  expect(report.step.bufferedSteps).toBe(2);
  expect(report.step.acceptedSteps.map((step) => step.toolNames)).toEqual([
    ['get_place_details'],
    ['submit_cards'],
  ]);
  expect(report.model.requests[1]?.sawIdentityObservation).toBe(true);
  expect(report.ephemeralResultsProjected).toBeGreaterThan(0);
  expect(report.transform.redactedToolResultParts).toBeGreaterThan(0);
  expectNoPersistedMarker(report);
});

it('keeps the invalid submit repair fact in the next Think step without persisting it', async () => {
  const report = await runFixture('invalid');

  expect(report.result?.status).toBe('completed');
  expect(report.toolExecutions.map((execution) => execution.name)).toEqual([
    'submit_cards',
    'get_place_details',
    'submit_cards',
  ]);
  expect(report.model.calls).toBe(3);
  expect(report.model.requests[1]?.sawMissingEvidence).toBe(true);
  expect(report.ephemeralResultsCaptured).toBeGreaterThanOrEqual(2);
  expect(report.ephemeralResultsProjected).toBeGreaterThanOrEqual(2);
  expect(report.core.repairCount).toBe(1);
  expect(report.core.commits).toHaveLength(1);
  expectNoPersistedMarker(report);
});

it('accepts a complete metadata-bearing final step through the Think loop', async () => {
  const report = await runFixture('step-valid');

  expect(report.result?.status).toBe('completed');
  expect(report.model.calls).toBe(1);
  expect(report.step.acceptedSteps[0]?.toolNames).toEqual([]);
  expect(report.step.acceptedSteps[0]?.turnConstraints).toEqual({
    changes: [
      {
        maxWalkMinutes: 15,
        homeStationRef: 'home-stn',
        minimumStayMinutes: 30,
        sourceTurnId: 'turn-1',
        quote: '15分以内',
      },
    ],
  });
  expectNoPersistedMarker(report);
});

it('rejects unsafe complete provider steps before any Think tool execution', async () => {
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
    expect(report.step.rejectedSteps).toEqual([code]);
    expect(report.toolExecutions).toEqual([]);
    expect(report.core.calls).toEqual([]);
    expect(report.core.commits).toEqual([]);
    expectNoPersistedMarker(report);
  }
});

it('keeps unknown tools and invalid known-tool arguments away from Core', async () => {
  const unknown = await runFixture('unknown-tool');
  expect(unknown.result?.status).toBe('error');
  expect(unknown.step.rejectedSteps).toEqual(['M04_STEP_DENY_UNKNOWN_TOOL']);
  expect(unknown.toolExecutions).toEqual([]);
  expect(unknown.core.calls).toEqual([]);

  const invalid = await runFixture('invalid-arguments');
  expect(invalid.result?.status).toBe('completed');
  expect(invalid.toolExecutions).toEqual([]);
  expect(invalid.core.calls).toEqual([]);
  expect(invalid.model.requests).toHaveLength(2);
  expect(invalid.ephemeralResultsProjected).toBe(0);
  expectNoPersistedMarker(unknown);
  expectNoPersistedMarker(invalid);
});

it('stops repair attempts at three, accepts an empty final, and handles timeout', async () => {
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
  expect(empty.step.acceptedSteps.map((step) => step.toolNames)).toEqual([['submit_cards']]);

  const timeout = await runFixture('timeout');
  expect(timeout.result?.status).toBe('error');
  expect(timeout.step.rejectedSteps).toEqual(['M04_STEP_DENY_TIMEOUT']);
  expect(timeout.toolExecutions).toEqual([]);
  expect(timeout.core.commits).toEqual([]);
  expectNoPersistedMarker(repairs);
  expectNoPersistedMarker(empty);
  expectNoPersistedMarker(timeout);
});

it('propagates cancellation through Think tool execution options', async () => {
  const report = await runFixture('cancel');

  expect(report.result?.status).toBe('aborted');
  expect(report.toolExecutions[0]?.abortSignalPassed).toBe(true);
  expect(report.core.commits).toEqual([]);
  expect(report.core.calls).toEqual([]);
  expectNoPersistedMarker(report);
});

it('withholds a random tool metadata canary from every persistence surface', async () => {
  const canary = `M04_RANDOM_CANARY_${crypto.randomUUID()}`;
  const report = await runFixture('sequence', { canary });

  expect(report.result?.status).toBe('completed');
  expect(report.canary?.value).toBe(canary);
  expect(report.toolExecutions.map((execution) => execution.name)).toEqual([
    'get_place_details',
    'submit_cards',
  ]);
  expect(report.core.commits).toHaveLength(1);
  expectNoPersistedCanary(report);
});

it('withholds metadata-free native content before SDK persistence on success, error, and cancel', async () => {
  for (const scenario of ['sequence', 'structured-error', 'cancel'] as const) {
    const canary = `M04_CONTENT_CANARY_${scenario}_${crypto.randomUUID()}`;
    const report = await runFixture(scenario, { content: canary, canary });
    expectNoPersistedCanary(report);
  }
});

it('projects metadata-free native content only for the current turn before and after eviction', async () => {
  const first = await runFixture('message', {
    id: NATIVE_CONTENT_AGENT,
    content: STALE_NATIVE_CONTENT_CANARY,
    canary: STALE_NATIVE_CONTENT_CANARY,
  });
  expect(first.model.requests[0]?.sawNativeContent).toBe(true);
  expectNoPersistedCanary(first);

  const nextContent = `M04_NATIVE_CONTENT_NEXT_${crypto.randomUUID()}`;
  const next = await runFixture('message', {
    id: NATIVE_CONTENT_AGENT,
    content: nextContent,
    canary: nextContent,
  });
  expect(next.model.requests[0]?.sawNativeContent).toBe(true);
  expect(next.model.requests.every((request) => request.sawStaleNativeContent)).toBe(false);
  expectNoPersistedCanary(next);

  await evictNativeContentAgent();
  const reopenedContent = `M04_NATIVE_CONTENT_REOPENED_${crypto.randomUUID()}`;
  const reopened = await runFixture('message', {
    id: NATIVE_CONTENT_AGENT,
    content: reopenedContent,
    canary: reopenedContent,
  });
  expect(reopened.model.requests[0]?.sawNativeContent).toBe(true);
  expect(reopened.model.requests.every((request) => request.sawStaleNativeContent)).toBe(false);
  expectNoPersistedCanary(reopened);
});

it('keeps random canaries out of Think tool logs on success, provider error, and cancellation', async () => {
  for (const scenario of ['sequence', 'structured-error', 'cancel'] as const) {
    const canary = `M04_LOG_CANARY_${scenario}_${crypto.randomUUID()}`;
    const logSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    try {
      const report = await runFixture(scenario, { canary });
      expectNoLoggedCanary(report, canary);
      const observedLogs = logSpies.flatMap((spy) => spy.mock.calls);
      expect(JSON.stringify(observedLogs)).not.toContain(canary);
    } finally {
      logSpies.forEach((spy) => spy.mockRestore());
    }
  }
});

it('returns 404 outside the Think runtime fixture route', async () => {
  const response = await SELF.fetch('https://ima.test/v1/think-runtime', { method: 'POST' });
  expect(response.status).toBe(404);
});
