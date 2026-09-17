import { describe, expect, it, vi } from 'vitest';
import type {
  CancellationToken,
  HarnessContext,
  PlaceDetailsPort,
  PlaceSearchPort,
  Result,
  SearchPlacesInput,
  SearchPlacesOutput,
  ToolExecutionContext,
} from '@ima/core';
import {
  DEFAULT_RUNTIME_BUDGET,
  RuntimeBudget,
  type RuntimeBudgetConfig,
} from '@api/runtime/budget/runtime-budget';
import {
  createRuntimeReadAttemptSignalBridge,
  createRuntimeReadPorts,
} from '@api/runtime/tool-reads/runtime-read-ports';
import { createHotPepperTransport } from '@api/providers/hot-pepper/transport';
import type { HotPepperSearchRequest } from '@api/providers/hot-pepper/types';

const context: HarnessContext = {
  threadId: 'thread-attempt-signal',
  turnId: 'turn-attempt-signal',
  revision: 1,
  serverNow: '2026-09-10T00:00:00Z',
  ownerScopeRef: 'owner-attempt-signal',
  location: {
    status: 'unavailable',
    coordinates: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
    revision: 1,
  },
  preferences: {
    homeStationRef: 'station-attempt-signal',
    maxWalkMinutes: 15,
    minimumStayMinutes: 20,
    areaText: '渋谷',
    budget: 'normal',
  },
  budget: {
    wallClockMs: 100,
    finalReserveMs: 10,
    modelCallsRemaining: 1,
    readCallsRemaining: 1,
    providerHttpRequestsRemaining: 1,
    retriesRemaining: 0,
  },
  capabilities: {
    version: 'attempt-signal-test-v1',
    detailFields: ['identity'],
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['attempt-signal-test'],
  },
};

const input: SearchPlacesInput = {
  mode: 'search',
  query: 'signal test',
  area: { kind: 'named_area', name: '渋谷' },
  openNow: true,
  limit: 1,
  excludeCandidateIds: [],
};

const execution: ToolExecutionContext = {
  callId: 'attempt-signal-call',
  operation: 'search_places',
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
};

const cancellation: CancellationToken = { isCancelled: () => false };

const timeoutFailure = (): Result<SearchPlacesOutput> => ({
  status: 'error',
  error: {
    code: 'INVALID_ARGUMENT',
    path: null,
    retryable: false,
    retryAfterMs: null,
    message: 'provider observed abort',
    missingFields: [],
  },
});

const budgetConfig = (overrides: Partial<RuntimeBudgetConfig> = {}): RuntimeBudgetConfig => ({
  ...DEFAULT_RUNTIME_BUDGET,
  ...overrides,
});

const deferred = <T>() => {
  let resolver: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      if (resolver === undefined) throw new Error('deferred resolver is unavailable');
      resolver(value);
    },
  };
};

describe('runtime read attempt signal bridge', () => {
  it('aborts the provider attempt and charges the read once on timeout', async () => {
    vi.useFakeTimers();
    try {
      const bridge = createRuntimeReadAttemptSignalBridge();
      let providerCalls = 0;
      let providerSignal: AbortSignal | undefined;
      let providerExecution: ToolExecutionContext | undefined;
      const started = deferred<void>();
      const search: PlaceSearchPort = {
        search: (_input, _context, receivedExecution) => {
          providerCalls += 1;
          started.resolve(undefined);
          providerExecution = receivedExecution;
          providerSignal = bridge.signalFor(receivedExecution);
          if (providerSignal === undefined) throw new Error('attempt signal was not bound');
          return new Promise((resolve) => {
            providerSignal?.addEventListener('abort', () => resolve(timeoutFailure()), {
              once: true,
            });
          });
        },
      };
      const details: PlaceDetailsPort = {
        read: () => Promise.reject(new Error('details should not be called')),
      };
      const budget = new RuntimeBudget({
        config: budgetConfig({ searchTimeoutMs: 5, maxReadRetries: 0 }),
        startedAtMs: 0,
        now: () => 0,
      });
      const ports = createRuntimeReadPorts({
        budget,
        ports: { search, details },
        resolveCost: () => ({ costUnits: 1, providerHttpRequests: 1, routeElements: 0 }),
        attemptSignalBridge: bridge,
      });

      const pending = ports.search.search(input, context, execution, cancellation);
      await started.promise;
      expect(providerCalls).toBe(1);
      expect(providerSignal).toBeInstanceOf(AbortSignal);
      expect(providerSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toMatchObject({
        status: 'error',
        error: { code: 'TIMEOUT' },
      });
      expect(providerSignal?.aborted).toBe(true);
      if (providerExecution === undefined) throw new Error('provider execution is unavailable');
      expect(bridge.signalFor(providerExecution)).toBeUndefined();
      expect(budget.snapshot()).toMatchObject({
        readCalls: 1,
        providerHttpRequests: 1,
        costUnits: 1,
        readRetries: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a retry signal bound while the timed out attempt finishes late', async () => {
    vi.useFakeTimers();
    try {
      const bridge = createRuntimeReadAttemptSignalBridge();
      const firstResult = deferred<Result<SearchPlacesOutput>>();
      const secondResult = deferred<Result<SearchPlacesOutput>>();
      const firstStarted = deferred<void>();
      const secondStarted = deferred<void>();
      let calls = 0;
      let firstExecution: ToolExecutionContext | undefined;
      let secondExecution: ToolExecutionContext | undefined;
      let firstSignal: AbortSignal | undefined;
      let secondSignal: AbortSignal | undefined;
      const search: PlaceSearchPort = {
        search: (_input, _context, receivedExecution) => {
          calls += 1;
          const signal = bridge.signalFor(receivedExecution);
          if (signal === undefined) throw new Error('attempt signal was not bound');
          if (calls === 1) {
            firstExecution = receivedExecution;
            firstSignal = signal;
            firstStarted.resolve(undefined);
            return firstResult.promise;
          }
          secondExecution = receivedExecution;
          secondSignal = signal;
          secondStarted.resolve(undefined);
          return secondResult.promise;
        },
      };
      const budget = new RuntimeBudget({
        config: budgetConfig({ searchTimeoutMs: 5, maxReadRetries: 1 }),
        startedAtMs: 0,
        now: () => 0,
      });
      const ports = createRuntimeReadPorts({
        budget,
        ports: {
          search,
          details: { read: () => Promise.reject(new Error('details should not be called')) },
        },
        resolveCost: () => ({ costUnits: 1, providerHttpRequests: 1, routeElements: 0 }),
        attemptSignalBridge: bridge,
      });

      const pending = ports.search.search(input, context, execution, cancellation);
      await firstStarted.promise;
      await vi.advanceTimersByTimeAsync(5);
      await secondStarted.promise;
      if (firstExecution === undefined || secondExecution === undefined) {
        throw new Error('both attempts must start');
      }
      expect(firstExecution).not.toBe(secondExecution);
      expect(firstSignal?.aborted).toBe(true);
      expect(bridge.signalFor(secondExecution)).toBe(secondSignal);

      firstResult.resolve({
        status: 'error',
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          path: null,
          retryable: true,
          retryAfterMs: null,
          message: 'late timeout result',
          missingFields: [],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(bridge.signalFor(secondExecution)).toBe(secondSignal);
      secondResult.resolve({
        status: 'ok',
        data: {
          searchId: 'search-attempt-signal',
          candidates: [],
          applied: { areaDescription: '渋谷', openNow: true, excludedCount: 0 },
          nextCursor: null,
          coverage: 'provider_results',
        },
        warnings: [],
      });
      await expect(pending).resolves.toMatchObject({ status: 'ok' });
      expect(calls).toBe(2);
      expect(budget.snapshot()).toMatchObject({
        readCalls: 1,
        providerHttpRequests: 2,
        costUnits: 2,
        readRetries: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the attempt abort through the real Places transport to fetch', async () => {
    vi.useFakeTimers();
    try {
      const bridge = createRuntimeReadAttemptSignalBridge();
      const fetchStarted = deferred<AbortSignal>();
      const fetcher: typeof fetch = (_input, init) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) throw new Error('fetch signal is missing');
        fetchStarted.resolve(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('fetch aborted')), {
            once: true,
          });
        });
      };
      const request: HotPepperSearchRequest = {
        keyword: 'signal transport test',
        count: 1,
      };
      const transport = createHotPepperTransport({
        apiKey: 'test-key',
        timeoutMs: 100,
        fetcher,
      });
      const search: PlaceSearchPort = {
        search: async (_input, _context, receivedExecution) => {
          const signal = bridge.signalFor(receivedExecution);
          if (signal === undefined) throw new Error('attempt signal was not bound');
          try {
            await transport.search(request, signal);
          } catch {
            return timeoutFailure();
          }
          return timeoutFailure();
        },
      };
      const budget = new RuntimeBudget({
        config: budgetConfig({ searchTimeoutMs: 5, maxReadRetries: 0 }),
        startedAtMs: 0,
        now: () => 0,
      });
      const ports = createRuntimeReadPorts({
        budget,
        ports: {
          search,
          details: { read: () => Promise.reject(new Error('details should not be called')) },
        },
        resolveCost: () => ({ costUnits: 1, providerHttpRequests: 1, routeElements: 0 }),
        attemptSignalBridge: bridge,
      });
      const pending = ports.search.search(input, context, execution, cancellation);
      const fetchSignal = await fetchStarted.promise;
      expect(fetchSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toMatchObject({
        status: 'error',
        error: { code: 'TIMEOUT' },
      });
      expect(fetchSignal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
