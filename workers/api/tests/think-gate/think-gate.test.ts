import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { ThinkGatePublicReport } from './think-gate-agent';

async function runFixture(
  mode:
    | 'raw-hooks'
    | 'buffered-model'
    | 'persistence-policy'
    | 'stream-transform'
    | 'stream-transform-ephemeral',
): Promise<ThinkGatePublicReport> {
  const response = await SELF.fetch(`https://ima.test/v1/think-gate?mode=${mode}`);
  expect(response.status).toBe(200);
  return response.json();
}

it('reproduces the public-hook boundary: a mixed step reaches tools before the full step is known', async () => {
  const report = await runFixture('raw-hooks');

  expect(report.mode).toBe('raw-hooks');
  expect(report.error).toBe(null);
  expect(report.model.calls).toBe(1);
  expect(report.model.requests[0]?.toolNames).toEqual([
    'get_place_details',
    'search_places',
    'submit_cards',
  ]);
  expect(report.beforeTurnSteps).toBe(1);
  expect(report.beforeStepNumbers).toEqual([0]);
  expect(report.beforeToolCalls).toEqual(['get_place_details', 'submit_cards']);
  expect(report.toolExecutions).toEqual(['get_place_details', 'submit_cards']);
  expect(report.step.bufferedSteps).toBe(0);
});

it('uses public wrapLanguageModel middleware to reject a mixed step before tools execute', async () => {
  const report = await runFixture('buffered-model');

  expect(report.mode).toBe('buffered-model');
  expect(report.error).toContain('M04_THINK_STEP_DENY_MIXED_READ_SUBMIT');
  expect(report.model.calls).toBe(1);
  expect(report.beforeTurnSteps).toBe(1);
  expect(report.beforeStepNumbers).toEqual([0]);
  expect(report.beforeToolCalls).toEqual([]);
  expect(report.toolExecutions).toEqual([]);
  expect(report.step.bufferedSteps).toBe(1);
  expect(report.step.acceptedSteps).toBe(0);
  expect(report.step.rejectedCodes).toEqual(['M04_THINK_STEP_DENY_MIXED_READ_SUBMIT']);
});

it('shows the public SessionProvider boundary for Think persistence', async () => {
  const report = await runFixture('persistence-policy');

  expect(report.mode).toBe('persistence-policy');
  expect(report.error).toBe(null);
  expect(report.resultStatus).toBe('completed');
  expect(report.configureSessionCalls).toBe(1);
  expect(report.liveCacheMarkerPresent).toBe(true);
  expect(report.sessionHistoryMarkerPresent).toBe(false);
  expect(report.storageMarkerCounts.assistant_messages).toEqual({
    observed: true,
    readError: null,
    count: 0,
  });
  expect(report.storageMarkerCounts.cf_ai_chat_stream_chunks).toMatchObject({
    observed: true,
    readError: null,
  });
  expect(report.storageMarkerCounts.cf_ai_chat_stream_chunks?.count).toBeGreaterThan(0);
});

it('uses public experimental_transform to redact generated and tool-result streams', async () => {
  const report = await runFixture('stream-transform');

  expect(report.mode).toBe('stream-transform');
  expect(report.error).toBe(null);
  expect(report.resultStatus).toBe('completed');
  expect(report.model.calls).toBe(2);
  expect(report.model.requests[1]).toMatchObject({
    promptHasMarker: false,
    promptHasToolPayload: true,
  });
  expect(report.streamTransform.markerParts).toBeGreaterThanOrEqual(2);
  expect(report.streamTransform.redactedParts).toBeGreaterThanOrEqual(2);
  expect(report.streamTransform.redactedTextParts).toBeGreaterThan(0);
  expect(report.streamTransform.redactedToolResultParts).toBeGreaterThan(0);
  expect(report.streamTransform.markerPartsAfterTransform).toBe(0);
  expect(report.liveCacheMarkerPresent).toBe(false);
  expect(report.sessionHistoryMarkerPresent).toBe(false);
  expect(report.storageMarkerCounts.assistant_messages).toEqual({
    observed: true,
    readError: null,
    count: 0,
  });
  expect(report.storageMarkerCounts.cf_ai_chat_stream_chunks).toEqual({
    observed: true,
    readError: null,
    count: 0,
  });
});

it('projects the current-turn ephemeral store fact back into the next model step', async () => {
  const report = await runFixture('stream-transform-ephemeral');

  expect(report.mode).toBe('stream-transform-ephemeral');
  expect(report.error).toBe(null);
  expect(report.resultStatus).toBe('completed');
  expect(report.ephemeralToolResultCaptured).toBe(true);
  expect(report.ephemeralToolResultProjected).toBe(true);
  expect(report.model.calls).toBe(2);
  expect(report.model.requests[1]).toMatchObject({
    promptHasMarker: true,
    promptHasRequiredStoreFact: true,
    promptHasToolPayload: true,
  });
  expect(report.streamTransform.markerPartsAfterTransform).toBe(0);
  expect(report.liveCacheMarkerPresent).toBe(false);
  expect(report.sessionHistoryMarkerPresent).toBe(false);
  expect(report.storageMarkerCounts.assistant_messages).toEqual({
    observed: true,
    readError: null,
    count: 0,
  });
  expect(report.storageMarkerCounts.cf_ai_chat_stream_chunks).toEqual({
    observed: true,
    readError: null,
    count: 0,
  });
});
