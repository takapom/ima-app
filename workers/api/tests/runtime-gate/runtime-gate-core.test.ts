import * as v from 'valibot';
import { expect, it } from 'vitest';
import { ResultSchema, SearchPlacesOutputSchema } from '@ima/core';
import {
  RuntimeGateCore,
  runtimeGateCancellation,
  runtimeGateExecutionContext,
  runtimeGateHarnessContext,
} from './runtime-gate-core';
import { detailsInput, searchInput, validSubmitInput } from '../support/runtime-model-fixture';

it('passes typed server context and cancellation through the public Core Ports', async () => {
  const core = new RuntimeGateCore();
  const context = runtimeGateHarnessContext({
    threadId: 'thread-port-test',
    turnId: 'turn-port-test',
    revision: 2,
  });
  const search = await core.search(
    searchInput,
    context,
    runtimeGateExecutionContext(context, 'search_places', 'port-call-1'),
    runtimeGateCancellation(undefined),
  );
  expect(search.status).toBe('ok');
  expect(v.safeParse(ResultSchema(SearchPlacesOutputSchema), search).success).toBe(true);
  expect(core.report.portCalls).toEqual([
    {
      operation: 'search_places',
      callId: 'port-call-1',
      threadId: 'thread-port-test',
      turnId: 'turn-port-test',
      revision: 2,
      cancelled: false,
    },
  ]);

  const cancelledCore = new RuntimeGateCore();
  const cancelled = await cancelledCore.read(
    detailsInput,
    context,
    runtimeGateExecutionContext(context, 'get_place_details', 'port-call-2'),
    { isCancelled: () => true },
  );
  expect(cancelled).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
  expect(cancelledCore.report.portCalls.at(-1)?.cancelled).toBe(true);
  expect(cancelledCore.report.calls).toEqual([]);

  const committed = await core.submit(
    validSubmitInput,
    runtimeGateExecutionContext(context, 'submit_cards', 'port-call-3'),
    runtimeGateCancellation(undefined),
  );
  expect(committed).toMatchObject({ status: 'committed', revision: 1 });
  expect(core.report.portCalls.at(-1)).toMatchObject({
    operation: 'submit_cards',
    callId: 'port-call-3',
    threadId: 'thread-port-test',
    turnId: 'turn-port-test',
    revision: 2,
    cancelled: false,
  });

  const invalidContextCore = new RuntimeGateCore();
  const invalidContext = { ...context, threadId: 'invalid context' };
  await expect(
    invalidContextCore.search(
      searchInput,
      invalidContext,
      runtimeGateExecutionContext(context, 'search_places', 'port-call-invalid'),
      runtimeGateCancellation(undefined),
    ),
  ).rejects.toThrow('RUNTIME_GATE_HARNESS_CONTEXT_SCHEMA_MISMATCH');
  expect(invalidContextCore.report.calls).toEqual([]);
});
