import { expect, it, vi } from 'vitest';
import {
  DEFAULT_RUNTIME_BUDGET,
  RuntimeBudget,
  type RuntimeBudgetConfig,
} from '@worker/infrastructure/runtime/budget/runtime-budget';
import {
  RuntimeReadExecutor,
  RuntimeReadFailure,
  type RuntimeReadExecutionRequest,
} from '@worker/infrastructure/runtime/tool-reads/runtime-read-executor';

const config = (overrides: Partial<RuntimeBudgetConfig> = {}): RuntimeBudgetConfig => ({
  ...DEFAULT_RUNTIME_BUDGET,
  ...overrides,
});

const request = <T>(
  invoke: (signal: AbortSignal) => Promise<T>,
  overrides: Partial<RuntimeReadExecutionRequest<T>> = {},
): RuntimeReadExecutionRequest<T> => ({
  callId: 'call-1',
  flightKey: 'scope/input/context/freshness',
  operation: 'search_places',
  costUnits: 1,
  providerHttpRequests: 1,
  routeElements: 0,
  invoke,
  ...overrides,
});

it('clamps a read timeout to the remaining read window', async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const budget = new RuntimeBudget({
      config: config({
        wholeTurnMs: 12_000,
        finalReserveMs: 2_000,
        searchTimeoutMs: 3_000,
        maxReadRetries: 0,
      }),
      startedAtMs: 0,
      now: () => 9_990,
    });
    const executor = new RuntimeReadExecutor({ budget });
    const pending = executor.execute(
      request(
        (signal) => {
          calls += 1;
          return new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('provider aborted')), {
              once: true,
            });
          });
        },
        { callId: 'call-clamped', flightKey: 'clamped' },
      ),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'timeout' },
      retryDenial: { code: 'BUDGET_EXCEEDED' },
      attempts: 1,
    });
  } finally {
    vi.useRealTimers();
  }
});

it('retries a transport failure once with the original request cost', async () => {
  let calls = 0;
  const budget = new RuntimeBudget({
    config: config({
      maxProviderHttpRequests: 2,
      maxCostUnits: 2,
    }),
    startedAtMs: 0,
    now: () => 1,
  });
  const executor = new RuntimeReadExecutor({ budget });
  const result = await executor.execute(
    request((signal) => {
      void signal;
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new RuntimeReadFailure('transport'));
      }
      return Promise.resolve('retried');
    }),
  );

  expect(result).toEqual({ ok: true, value: 'retried', attempts: 2 });
  expect(calls).toBe(2);
  expect(budget.snapshot()).toMatchObject({
    providerHttpRequests: 2,
    costUnits: 2,
    readRetries: 1,
  });
});

it('waits for Retry-After and does not retry a rate limit without a delay', async () => {
  let calls = 0;
  const budget = new RuntimeBudget({ startedAtMs: 0, now: () => 1 });
  const executor = new RuntimeReadExecutor({ budget });
  const result = await executor.execute(
    request(() => {
      calls += 1;
      if (calls === 1) {
        throw new RuntimeReadFailure('rate_limited', { retryAfterMs: 1 });
      }
      return Promise.resolve('ready');
    }),
  );

  expect(result).toEqual({ ok: true, value: 'ready', attempts: 2 });
  expect(calls).toBe(2);

  const noDelay = new RuntimeReadExecutor({
    budget: new RuntimeBudget({ startedAtMs: 0, now: () => 1 }),
  });
  const noDelayResult = await noDelay.execute(
    request(
      () => {
        throw new RuntimeReadFailure('rate_limited');
      },
      { callId: 'call-no-delay', flightKey: 'no-delay' },
    ),
  );
  expect(noDelayResult).toMatchObject({
    ok: false,
    failure: { kind: 'rate_limited' },
    retryDenial: null,
    attempts: 1,
  });
});

it('does not start a retry after the final reserve begins while waiting', async () => {
  vi.useFakeTimers();
  try {
    let now = 100;
    let calls = 0;
    const budget = new RuntimeBudget({ startedAtMs: 0, now: () => now });
    const executor = new RuntimeReadExecutor({ budget });
    const pending = executor.execute(
      request(
        () => {
          calls += 1;
          throw new RuntimeReadFailure('rate_limited', { retryAfterMs: 100 });
        },
        { callId: 'call-late-retry', flightKey: 'late-retry' },
      ),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    now = DEFAULT_RUNTIME_BUDGET.wholeTurnMs - DEFAULT_RUNTIME_BUDGET.finalReserveMs + 1;
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      denial: { code: 'FINAL_RESERVE' },
      attempts: 1,
    });
    expect(calls).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it('returns non-retryable failures and propagates unexpected provider exceptions', async () => {
  const argumentExecutor = new RuntimeReadExecutor({
    budget: new RuntimeBudget({ startedAtMs: 0, now: () => 1 }),
  });
  let argumentCalls = 0;
  const argumentResult = await argumentExecutor.execute(
    request(() => {
      argumentCalls += 1;
      throw new RuntimeReadFailure('argument');
    }),
  );
  expect(argumentResult).toMatchObject({
    ok: false,
    failure: { kind: 'argument' },
    retryDenial: null,
    attempts: 1,
  });
  expect(argumentCalls).toBe(1);

  const unexpected = new Error('provider bug');
  const unexpectedExecutor = new RuntimeReadExecutor({
    budget: new RuntimeBudget({ startedAtMs: 0, now: () => 1 }),
  });
  await expect(
    unexpectedExecutor.execute(
      request(
        () => {
          throw unexpected;
        },
        { callId: 'call-unexpected', flightKey: 'unexpected' },
      ),
    ),
  ).rejects.toBe(unexpected);
});

it('reserves before invoking and reports retry budget denial without a second call', async () => {
  let calls = 0;
  const budget = new RuntimeBudget({
    config: config({ maxProviderHttpRequests: 5 }),
    startedAtMs: 0,
    now: () => 1,
  });
  const executor = new RuntimeReadExecutor({ budget });
  const result = await executor.execute(
    request(
      () => {
        calls += 1;
        throw new RuntimeReadFailure('server');
      },
      { providerHttpRequests: 3, costUnits: 4, routeElements: 2 },
    ),
  );
  expect(result).toMatchObject({
    ok: false,
    failure: { kind: 'server' },
    retryDenial: { code: 'BUDGET_EXCEEDED' },
    attempts: 1,
  });
  expect(calls).toBe(1);
  expect(budget.snapshot()).toMatchObject({
    providerHttpRequests: 3,
    costUnits: 4,
    routeElements: 2,
  });

  const deniedBudget = new RuntimeBudget({
    config: config({ maxProviderHttpRequests: 1 }),
    startedAtMs: 0,
    now: () => 1,
  });
  let deniedCalls = 0;
  const denied = await new RuntimeReadExecutor({ budget: deniedBudget }).execute(
    request(
      () => {
        deniedCalls += 1;
        return Promise.resolve('unreachable');
      },
      { callId: 'call-denied', flightKey: 'denied', providerHttpRequests: 2 },
    ),
  );
  expect(denied).toMatchObject({ ok: false, denial: { code: 'BUDGET_EXCEEDED' }, attempts: 0 });
  expect(deniedCalls).toBe(0);
});

it('shares one admitted provider call for concurrent equivalent reads', async () => {
  let calls = 0;
  let resolveRead: ((value: string) => void) | undefined;
  const budget = new RuntimeBudget({ startedAtMs: 0, now: () => 1 });
  const executor = new RuntimeReadExecutor({ budget });
  const invoke = (): Promise<string> => {
    calls += 1;
    return new Promise((resolve) => {
      resolveRead = resolve;
    });
  };
  const first = executor.execute(request(invoke, { callId: 'call-1' }));
  const second = executor.execute(request(invoke, { callId: 'call-2' }));
  expect(second).toBe(first);
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(1);
  if (resolveRead === undefined) throw new Error('read was not started');
  resolveRead('shared');
  await expect(first).resolves.toEqual({ ok: true, value: 'shared', attempts: 1 });
  expect(budget.snapshot()).toMatchObject({ readCalls: 1, providerHttpRequests: 1 });
});

it('does not invoke a provider after immediate cancellation or disposal', async () => {
  let calls = 0;
  const controller = new AbortController();
  const cancelled = new RuntimeReadExecutor({
    budget: new RuntimeBudget({ signal: controller.signal, startedAtMs: 0, now: () => 1 }),
    signal: controller.signal,
  });
  const pending = cancelled.execute(
    request(() => {
      calls += 1;
      return Promise.resolve('unexpected');
    }),
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });

  const disposed = new RuntimeReadExecutor({
    budget: new RuntimeBudget({ startedAtMs: 0, now: () => 1 }),
  });
  const disposedPending = disposed.execute(
    request(
      () => {
        calls += 1;
        return Promise.resolve('unexpected');
      },
      { callId: 'call-disposed', flightKey: 'disposed' },
    ),
  );
  disposed.dispose();
  await expect(disposedPending).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(calls).toBe(0);
});

it('returns cancellation when disposal aborts an already running provider call', async () => {
  let calls = 0;
  const executor = new RuntimeReadExecutor({
    budget: new RuntimeBudget({ startedAtMs: 0, now: () => 1 }),
  });
  const pending = executor.execute(
    request(
      (signal) => {
        calls += 1;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('provider aborted')), {
            once: true,
          });
        });
      },
      { callId: 'call-running', flightKey: 'running' },
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  executor.dispose();
  await expect(pending).resolves.toMatchObject({ ok: false, denial: { code: 'CANCELLED' } });
  expect(calls).toBe(1);
});

it('propagates the pending read deadline to the running provider attempt', async () => {
  vi.useFakeTimers();
  try {
    let now = 0;
    const budget = new RuntimeBudget({
      startedAtMs: 0,
      now: () => now,
    });
    expect(budget.reserveReadSlot('call-pending')).toMatchObject({ ok: true });

    await vi.advanceTimersByTimeAsync(3_000);
    now = 3_000;
    const executor = new RuntimeReadExecutor({ budget });
    let providerStarted = false;
    let providerAborted = false;
    const pending = executor.execute(
      request(
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            providerStarted = true;
            signal.addEventListener(
              'abort',
              () => {
                providerAborted = true;
                reject(new Error('provider aborted'));
              },
              { once: true },
            );
          }),
        { callId: 'call-pending', flightKey: 'pending' },
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(providerStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(providerAborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      denial: { code: 'CANCELLED' },
    });
    expect(providerAborted).toBe(true);
    expect(budget.snapshot().activeReads).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('rejects a late result when the turn revision becomes stale', async () => {
  let stale = false;
  let resolveRead: ((value: string) => void) | undefined;
  let calls = 0;
  const executor = new RuntimeReadExecutor({
    budget: new RuntimeBudget({ startedAtMs: 0, now: () => 1 }),
    isStale: () => stale,
  });
  const pending = executor.execute(
    request(
      () => {
        calls += 1;
        return new Promise<string>((resolve) => {
          resolveRead = resolve;
        });
      },
      { callId: 'call-stale', flightKey: 'stale' },
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(1);
  stale = true;
  if (resolveRead === undefined) throw new Error('read was not started');
  resolveRead('late');
  await expect(pending).resolves.toMatchObject({
    ok: false,
    denial: { code: 'STALE_TURN' },
    attempts: 1,
  });
});
