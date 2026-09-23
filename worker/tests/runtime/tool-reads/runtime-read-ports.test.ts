import { describe, expect, it, vi } from 'vitest';
import type {
  CancellationToken,
  HarnessContext,
  ToolExecutionContext,
} from '@worker/application/ports/context';
import type {
  GetPlaceDetailsInput,
  GetPlaceDetailsOutput,
  PlaceDetailsPort,
  PlaceSearchPort,
  SearchPlacesInput,
  SearchPlacesOutput,
} from '@worker/application/ports/operations';
import type { ModelActionMetadata } from '@worker/domain/constraints/constraints';
import type { Result } from '@worker/domain/result';
import {
  DEFAULT_RUNTIME_BUDGET,
  RuntimeBudget,
  type RuntimeBudgetConfig,
} from '@worker/runtime/budget/runtime-budget';
import {
  createRuntimeReadPorts,
  type RuntimeReadCostRequest,
  type RuntimeReadPortOptions,
} from '@worker/runtime/tool-reads/runtime-read-ports';
import { runtimeFor } from '@worker/adapters/in/tools/validation';

const budgetConfig = (overrides: Partial<RuntimeBudgetConfig> = {}): RuntimeBudgetConfig => ({
  ...DEFAULT_RUNTIME_BUDGET,
  ...overrides,
});

const context = (revision = 1): HarnessContext => ({
  threadId: 'thread-read',
  turnId: 'turn-read',
  revision,
  serverNow: '2026-09-10T00:00:00Z',
  ownerScopeRef: 'owner-read',
  location: {
    status: 'unavailable',
    coordinates: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
    revision,
  },
  preferences: {
    homeStationRef: 'station-read',
    maxWalkMinutes: 15,
    minimumStayMinutes: 20,
    areaText: '渋谷',
    budget: 'normal',
  },
  budget: {
    wallClockMs: 12_000,
    finalReserveMs: 2_000,
    modelCallsRemaining: 4,
    readCallsRemaining: 8,
    providerHttpRequestsRemaining: 20,
    retriesRemaining: 1,
  },
  capabilities: {
    version: 'tools-v1',
    detailFields: ['identity'],
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['read-fixture'],
  },
});

const reorderedContext = (): HarnessContext => {
  const base = context();
  return {
    capabilities: base.capabilities,
    budget: base.budget,
    preferences: base.preferences,
    location: base.location,
    ownerScopeRef: base.ownerScopeRef,
    serverNow: base.serverNow,
    revision: base.revision,
    turnId: base.turnId,
    threadId: base.threadId,
  };
};

const searchInput: SearchPlacesInput = {
  mode: 'search',
  query: '静かなカフェ',
  area: { kind: 'named_area', name: '渋谷' },
  openNow: true,
  limit: 2,
  excludeCandidateIds: [],
};

const detailsInput = (freshness: GetPlaceDetailsInput['freshness']): GetPlaceDetailsInput => ({
  requests: [{ candidateId: 'candidate-read', fields: ['identity'] }],
  freshness,
});

const execution = (
  callId: string,
  operation: ToolExecutionContext['operation'] = 'search_places',
  revision = 1,
): ToolExecutionContext => ({
  callId,
  operation,
  threadId: 'thread-read',
  turnId: 'turn-read',
  revision,
});

const cancellation: CancellationToken = { isCancelled: () => false };

const searchSuccess = (): Result<SearchPlacesOutput> => ({
  status: 'ok',
  data: {
    searchId: 'search-read',
    candidates: [],
    applied: { areaDescription: '渋谷', openNow: true, excludedCount: 0 },
    nextCursor: null,
    coverage: 'provider_results',
  },
  warnings: [],
});

const detailsSuccess = (): Result<GetPlaceDetailsOutput> => ({
  status: 'ok',
  data: {
    items: [
      {
        candidateId: 'candidate-read',
        fields: { identity: { status: 'unknown', reason: 'fixture' } },
      },
    ],
  },
  warnings: [],
});

const transientFailure = (): Result<SearchPlacesOutput> => ({
  status: 'error',
  error: {
    code: 'UPSTREAM_UNAVAILABLE',
    path: null,
    retryable: true,
    retryAfterMs: null,
    message: 'temporary provider failure',
    missingFields: [],
  },
});

const nonRetryableFailure = (): Result<SearchPlacesOutput> => ({
  status: 'error',
  error: {
    code: 'INVALID_ARGUMENT',
    path: 'query',
    retryable: false,
    retryAfterMs: null,
    message: 'invalid query',
    missingFields: [],
  },
});

const makeOptions = (
  ports: { readonly search: PlaceSearchPort; readonly details: PlaceDetailsPort },
  resolveCost: RuntimeReadPortOptions['resolveCost'],
  overrides: Partial<RuntimeReadPortOptions> = {},
): RuntimeReadPortOptions => ({
  budget: new RuntimeBudget({ startedAtMs: 0, now: () => 1 }),
  ports,
  resolveCost,
  ...overrides,
});

const fixedCost = (): ReturnType<RuntimeReadPortOptions['resolveCost']> => ({
  costUnits: 1,
  providerHttpRequests: 1,
  routeElements: 0,
});

describe('runtime read Port adapter', () => {
  it('resolves costs before the provider and returns the Core result', async () => {
    let calls = 0;
    const requests: RuntimeReadCostRequest[] = [];
    const search: PlaceSearchPort = {
      search: () => {
        calls += 1;
        return Promise.resolve(searchSuccess());
      },
    };
    const details: PlaceDetailsPort = { read: () => Promise.resolve(detailsSuccess()) };
    const budget = new RuntimeBudget({
      config: budgetConfig({ maxRouteElements: 1 }),
      startedAtMs: 0,
      now: () => 1,
    });
    const ports = createRuntimeReadPorts(
      makeOptions(
        { search, details },
        (request) => {
          requests.push(request);
          return { costUnits: 1, providerHttpRequests: 1, routeElements: 1 };
        },
        { budget },
      ),
    );

    const result = await ports.search.search(
      searchInput,
      context(),
      execution('server-read-1'),
      cancellation,
    );

    expect(result).toEqual(searchSuccess());
    expect(calls).toBe(1);
    expect(requests[0]).toMatchObject({ operation: 'search_places', input: searchInput });
    expect(budget.snapshot()).toMatchObject({
      readCalls: 1,
      providerHttpRequests: 1,
      costUnits: 1,
      routeElements: 1,
    });
  });

  it('denies an over-budget read before calling its Port', async () => {
    let calls = 0;
    const search: PlaceSearchPort = {
      search: () => {
        calls += 1;
        return Promise.resolve(searchSuccess());
      },
    };
    const ports = createRuntimeReadPorts(
      makeOptions(
        { search, details: { read: () => Promise.resolve(detailsSuccess()) } },
        () => ({ costUnits: 2, providerHttpRequests: 1, routeElements: 0 }),
        { budget: new RuntimeBudget({ config: budgetConfig({ maxCostUnits: 1 }) }) },
      ),
    );

    const result = await ports.search.search(
      searchInput,
      context(),
      execution('server-read-denied'),
      cancellation,
    );

    expect(result).toMatchObject({ status: 'error', error: { code: 'BUDGET_EXCEEDED' } });
    expect(calls).toBe(0);
  });

  it('shares equivalent reads but separates context and freshness changes', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const search: PlaceSearchPort = {
      search: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve(searchSuccess());
        return new Promise((resolve) => {
          release = () => resolve(searchSuccess());
        });
      },
    };
    const details: PlaceDetailsPort = {
      read: () => {
        calls += 1;
        return Promise.resolve(detailsSuccess());
      },
    };
    const ports = createRuntimeReadPorts(makeOptions({ search, details }, fixedCost));

    const first = ports.search.search(
      searchInput,
      context(),
      execution('server-read-a'),
      cancellation,
    );
    const second = ports.search.search(
      searchInput,
      reorderedContext(),
      execution('server-read-b'),
      cancellation,
    );
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(calls).toBe(1);
    if (release === undefined) throw new Error('shared read was not started');
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([searchSuccess(), searchSuccess()]);

    const changedContext = ports.search.search(
      searchInput,
      context(2),
      execution('server-read-c', 'search_places', 2),
      cancellation,
    );
    await expect(changedContext).resolves.toEqual(searchSuccess());

    const reuse = ports.details.read(
      detailsInput('reuse_valid'),
      context(),
      execution('server-read-d', 'get_place_details'),
      cancellation,
    );
    const refresh = ports.details.read(
      detailsInput('refresh'),
      context(),
      execution('server-read-e', 'get_place_details'),
      cancellation,
    );
    await expect(Promise.all([reuse, refresh])).resolves.toEqual([
      detailsSuccess(),
      detailsSuccess(),
    ]);
    expect(calls).toBe(4);
  });

  it('retries a retryable Core provider error once and preserves non-retryable errors', async () => {
    let calls = 0;
    const search: PlaceSearchPort = {
      search: () => {
        calls += 1;
        return Promise.resolve(calls === 1 ? transientFailure() : searchSuccess());
      },
    };
    const budget = new RuntimeBudget({
      config: budgetConfig({ maxProviderHttpRequests: 2, maxCostUnits: 2 }),
      startedAtMs: 0,
      now: () => 1,
    });
    const ports = createRuntimeReadPorts(
      makeOptions(
        { search, details: { read: () => Promise.resolve(detailsSuccess()) } },
        fixedCost,
        { budget },
      ),
    );
    await expect(
      ports.search.search(searchInput, context(), execution('server-read-retry'), cancellation),
    ).resolves.toEqual(searchSuccess());
    expect(calls).toBe(2);
    expect(budget.snapshot()).toMatchObject({ readRetries: 1, providerHttpRequests: 2 });

    const noRetry = createRuntimeReadPorts(
      makeOptions(
        {
          search: { search: () => Promise.resolve(nonRetryableFailure()) },
          details: { read: () => Promise.resolve(detailsSuccess()) },
        },
        fixedCost,
      ),
    );
    await expect(
      noRetry.search.search(
        searchInput,
        context(),
        execution('server-read-no-retry'),
        cancellation,
      ),
    ).resolves.toEqual(nonRetryableFailure());
  });

  it('propagates unexpected provider exceptions and maps cancellation', async () => {
    const unexpected = new Error('provider bug');
    const ports = createRuntimeReadPorts(
      makeOptions(
        {
          search: { search: () => Promise.reject(unexpected) },
          details: { read: () => Promise.resolve(detailsSuccess()) },
        },
        fixedCost,
      ),
    );
    await expect(
      ports.search.search(searchInput, context(), execution('server-read-error'), cancellation),
    ).rejects.toBe(unexpected);

    const controller = new AbortController();
    const cancelledPorts = createRuntimeReadPorts(
      makeOptions(
        {
          search: { search: () => Promise.resolve(searchSuccess()) },
          details: { read: () => Promise.resolve(detailsSuccess()) },
        },
        fixedCost,
        { signal: controller.signal },
      ),
    );
    controller.abort();
    await expect(
      cancelledPorts.search.search(
        searchInput,
        context(),
        execution('server-read-cancelled'),
        cancellation,
      ),
    ).resolves.toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
  });

  it('maps a runtime factory failure from runtimeFor to MISSING_CONTEXT', () => {
    const metadata: ModelActionMetadata = {};
    const other = runtimeFor(
      () => {
        throw new Error('runtime failure');
      },
      'search_places',
      { toolCallId: 'sdk-read-other' },
      metadata,
    );
    expect(other).toMatchObject({ ok: false, error: { code: 'MISSING_CONTEXT' } });
  });

  it('aborts a hanging Port at the configured read timeout', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const search: PlaceSearchPort = {
        search: (_input, _context, _execution, token) =>
          new Promise((_resolve, reject) => {
            const timer = setInterval(() => {
              if (!token.isCancelled()) return;
              clearInterval(timer);
              aborted = true;
              reject(new Error('provider aborted'));
            }, 1);
          }),
      };
      const ports = createRuntimeReadPorts(
        makeOptions(
          { search, details: { read: () => Promise.resolve(detailsSuccess()) } },
          fixedCost,
          {
            budget: new RuntimeBudget({
              config: budgetConfig({ searchTimeoutMs: 10, maxReadRetries: 0 }),
              startedAtMs: 0,
              now: () => 1,
            }),
          },
        ),
      );
      const pending = ports.search.search(
        searchInput,
        context(),
        execution('server-read-timeout'),
        cancellation,
      );
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(11);
      await expect(pending).resolves.toMatchObject({ status: 'error', error: { code: 'TIMEOUT' } });
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
