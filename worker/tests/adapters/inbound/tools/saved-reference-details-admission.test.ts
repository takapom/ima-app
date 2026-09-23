import { expect, it, vi } from 'vitest';
import type {
  GetPlaceDetailsInput,
  ModelGetPlaceDetailsInput,
  PlaceDetailsPort,
  PlaceSearchPort,
} from '@worker/application/ports/operations';
import type { HarnessContext, ToolExecutionContext } from '@worker/application/ports/context';
import type { SubmitCardsPort } from '@worker/application/ports/submission';
import { DEFAULT_RUNTIME_BUDGET, RuntimeBudget } from '@worker/runtime/budget/runtime-budget';
import {
  invokePublicTool,
  type ToolBindingDependencies,
  type ToolRuntime,
} from '@worker/adapters/in/tools';
import { createToolRegistry, toolScope } from './registry-fixture';

const context: HarnessContext = {
  ownerScopeRef: toolScope.ownerScopeRef,
  threadId: toolScope.threadId,
  turnId: 'turn-saved-details-admission',
  revision: 1,
  serverNow: '2026-09-10T00:00:00Z',
  location: {
    status: 'unavailable',
    coordinates: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
    revision: 1,
  },
  preferences: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: '渋谷',
    budget: 'normal',
  },
  budget: {
    wallClockMs: 2_000,
    finalReserveMs: 250,
    modelCallsRemaining: 1,
    readCallsRemaining: 5,
    providerHttpRequestsRemaining: 5,
    retriesRemaining: 0,
  },
  capabilities: {
    version: 'saved-details-admission-v1',
    detailFields: ['identity'],
    supportedScopes: ['saved-details-fixture'],
  },
};

const execution: ToolExecutionContext = {
  callId: 'call-saved-details-admission',
  operation: 'get_place_details',
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
};

const input = (requests: ModelGetPlaceDetailsInput['requests']): ModelGetPlaceDetailsInput => ({
  requests,
  freshness: 'refresh',
});

const makeDependencies = (options: {
  readonly registry: ToolBindingDependencies['registry'];
  readonly details: PlaceDetailsPort;
  readonly resolver?: ToolBindingDependencies['savedPlaceReferenceResolver'];
  readonly readAdmission?: ToolBindingDependencies['readAdmission'];
}): ToolBindingDependencies => {
  const search: PlaceSearchPort = {
    search: () => Promise.reject(new Error('search should not be called')),
  };
  const submit: SubmitCardsPort = {
    submit: () => Promise.reject(new Error('submit should not be called')),
  };
  const runtime: ToolRuntime = {
    context,
    execution,
    cancellation: { isCancelled: () => false },
    remainingRepairs: 0,
  };
  return {
    registry: options.registry,
    clock: () => context.serverNow,
    search,
    details: options.details,
    submit,
    ...(options.resolver === undefined ? {} : { savedPlaceReferenceResolver: options.resolver }),
    ...(options.readAdmission === undefined ? {} : { readAdmission: options.readAdmission }),
    runtime: () => runtime,
  };
};

const detailsPort = (calls: GetPlaceDetailsInput[]): PlaceDetailsPort => ({
  read: (received) => {
    calls.push(received);
    return Promise.resolve({
      status: 'ok',
      data: {
        items: received.requests.map((request) => ({
          candidateId: request.candidateId,
          fields: { identity: { status: 'unknown', reason: 'fixture' } },
        })),
      },
      warnings: [],
    });
  },
});

const readAdmissionFor = (
  budget: RuntimeBudget,
): NonNullable<ToolBindingDependencies['readAdmission']> => ({
  reserve: ({ callId, signal }) => {
    const result = budget.reserveReadSlot(callId, signal);
    return result.ok
      ? { ok: true }
      : {
          ok: false,
          error: {
            code: 'BUDGET_EXCEEDED',
            path: null,
            retryable: false,
            retryAfterMs: null,
            message: result.denial.message,
            missingFields: [],
          },
        };
  },
  signalFor: (callId) => budget.readSignalFor(callId),
  release: (callId) => budget.releaseReadSlot(callId),
});

it('rejects saved resolution before the resolver when read admission is exhausted', async () => {
  const cases = [
    {
      label: 'read-call-limit',
      budget: new RuntimeBudget({
        config: { ...DEFAULT_RUNTIME_BUDGET, maxReadCalls: 1 },
        startedAtMs: 0,
        now: () => 1,
      }),
      holder: 'read-limit-holder',
    },
    {
      label: 'parallel-limit',
      budget: new RuntimeBudget({
        config: { ...DEFAULT_RUNTIME_BUDGET, maxParallelReads: 1 },
        startedAtMs: 0,
        now: () => 1,
      }),
      holder: 'parallel-holder',
    },
    {
      label: 'final-reserve',
      budget: new RuntimeBudget({
        config: { ...DEFAULT_RUNTIME_BUDGET, wholeTurnMs: 100, finalReserveMs: 20 },
        startedAtMs: 0,
        now: () => 80,
      }),
      holder: undefined,
    },
  ] as const;

  for (const current of cases) {
    if (current.holder !== undefined) {
      expect(current.budget.reserveReadSlot(current.holder)).toMatchObject({ ok: true });
      if (current.label === 'read-call-limit') current.budget.releaseReadSlot(current.holder);
    }
    const fixture = createToolRegistry();
    const calls: GetPlaceDetailsInput[] = [];
    const resolver = vi.fn(() =>
      Promise.resolve({ status: 'ok' as const, candidateId: fixture.currentCandidateId }),
    );
    const result = await invokePublicTool(
      'get_place_details',
      input([{ savedPlaceRef: `saved-${current.label}`, fields: ['identity'] }]),
      makeDependencies({
        registry: fixture.registry,
        details: detailsPort(calls),
        resolver,
        readAdmission: readAdmissionFor(current.budget),
      }),
      { toolCallId: execution.callId },
    );

    expect(result).toMatchObject({ status: 'error', error: { code: 'BUDGET_EXCEEDED' } });
    expect(resolver).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    if (current.holder !== undefined) current.budget.releaseReadSlot(current.holder);
  }
});

it('settles an uncooperative saved resolver at the read deadline without registering a late result', async () => {
  vi.useFakeTimers();
  try {
    const budget = new RuntimeBudget({
      config: {
        ...DEFAULT_RUNTIME_BUDGET,
        wholeTurnMs: 100,
        finalReserveMs: 20,
        detailsTimeoutMs: 5,
      },
      startedAtMs: 0,
      now: () => 0,
    });
    const fixture = createToolRegistry();
    const candidatesBefore = fixture.registry.listCandidates(toolScope);
    const calls: GetPlaceDetailsInput[] = [];
    let release: ((value: unknown) => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const resolver: ToolBindingDependencies['savedPlaceReferenceResolver'] = () => {
      startedResolve?.();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const pending = invokePublicTool(
      'get_place_details',
      input([{ savedPlaceRef: 'saved-timeout', fields: ['identity'] }]),
      makeDependencies({
        registry: fixture.registry,
        details: detailsPort(calls),
        resolver,
        readAdmission: readAdmissionFor(budget),
      }),
      { toolCallId: execution.callId },
    );
    await started;
    await vi.advanceTimersByTimeAsync(5);

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'CANCELLED' },
    });
    expect(calls).toHaveLength(0);
    expect(budget.snapshot().activeReads).toBe(0);
    release?.({ status: 'ok', candidateId: fixture.currentCandidateId });
    await Promise.resolve();
    expect(fixture.registry.listCandidates(toolScope)).toEqual(candidatesBefore);
  } finally {
    vi.useRealTimers();
  }
});
