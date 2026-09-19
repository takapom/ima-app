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
import type { Issue } from '@worker/domain/issue';
import type { Result } from '@worker/domain/result';
import {
  RuntimeReadExecutor,
  RuntimeReadFailure,
  type RuntimeReadExecutionRequest,
  type RuntimeReadExecutionResult,
  type RuntimeReadFailureKind,
} from '@worker/runtime/tool-reads/runtime-read-executor';
import type { RuntimeBudget, RuntimeBudgetDenial } from '@worker/runtime/budget/runtime-budget';
import { RuntimeSingleFlightError } from '@worker/runtime/tool-reads/runtime-singleflight';

export type RuntimeReadCost = {
  readonly costUnits: number;
  readonly providerHttpRequests: number;
  readonly routeElements: number;
};

export type RuntimeReadCostRequest =
  | {
      readonly operation: 'search_places';
      readonly input: SearchPlacesInput;
      readonly context: HarnessContext;
    }
  | {
      readonly operation: 'get_place_details';
      readonly input: GetPlaceDetailsInput;
      readonly context: HarnessContext;
    };

export type RuntimeReadCostResolver = (request: RuntimeReadCostRequest) => RuntimeReadCost;

export type RuntimeReadPortOptions = {
  readonly budget: RuntimeBudget;
  /** Computes all cost dimensions before RuntimeReadExecutor can call a Port. */
  readonly resolveCost: RuntimeReadCostResolver;
  /** Application-owned ports; this adapter only adds runtime admission around them. */
  readonly ports: {
    readonly search: PlaceSearchPort;
    readonly details: PlaceDetailsPort;
  };
  readonly signal?: AbortSignal;
  readonly isStale?: () => boolean;
  /** Bridges each executor attempt to provider adapters without changing the Core Port contract. */
  readonly attemptSignalBridge?: RuntimeReadAttemptSignalBridge;
};

export type RuntimeReadAttemptSignalBridge = {
  readonly bind: (execution: ToolExecutionContext, signal: AbortSignal) => () => void;
  readonly signalFor: (execution: ToolExecutionContext) => AbortSignal | undefined;
};

/**
 * The Core cancellation token intentionally has no platform signal. This Worker-owned bridge
 * exposes the executor's per-attempt signal to an adapter while the adapter call is in flight.
 * WeakMap scope prevents a retry or a later turn from reusing an old provider signal.
 */
export const createRuntimeReadAttemptSignalBridge = (): RuntimeReadAttemptSignalBridge => {
  const signals = new WeakMap<object, AbortSignal>();
  return {
    bind: (execution, signal) => {
      signals.set(execution, signal);
      return () => {
        if (signals.get(execution) === signal) signals.delete(execution);
      };
    },
    signalFor: (execution) => signals.get(execution),
  };
};

export type RuntimeReadPorts = {
  readonly search: PlaceSearchPort;
  readonly details: PlaceDetailsPort;
  readonly admission: {
    readonly reserve: (input: {
      readonly callId: string;
      readonly operation: 'get_place_details';
      readonly signal?: AbortSignal;
    }) => { readonly ok: true } | { readonly ok: false; readonly error: Issue };
    readonly signalFor: (callId: string) => AbortSignal | undefined;
    readonly release: (callId: string) => void;
  };
  readonly dispose: () => void;
};

class RuntimeReadPortCancelled extends Error {
  constructor() {
    super('runtime read port cancelled');
    this.name = 'RuntimeReadPortCancelled';
  }
}

class KnownPortFailure extends RuntimeReadFailure {
  readonly issue: Issue;

  constructor(kind: RuntimeReadFailureKind, issue: Issue) {
    super(kind, { retryAfterMs: issue.retryAfterMs });
    this.name = 'KnownPortFailure';
    this.issue = issue;
  }
}

const issue = (
  code: Issue['code'],
  message: string,
  retryable = false,
  retryAfterMs: number | null = null,
): Issue => ({
  code,
  path: null,
  retryable,
  retryAfterMs,
  message,
  missingFields: [],
});

const resultError = <T>(error: Issue): Result<T> => ({ status: 'error', error });

const issueForDenial = (denial: RuntimeBudgetDenial): Issue => {
  switch (denial.code) {
    case 'CANCELLED':
      return issue('CANCELLED', denial.message);
    case 'STALE_TURN':
      return issue('STALE_TURN', denial.message);
    case 'DEADLINE':
      return issue('TIMEOUT', denial.message);
    case 'BUDGET_EXCEEDED':
    case 'FINAL_RESERVE':
    case 'PARALLEL_LIMIT':
    case 'COMMITTED':
    case 'RETRY_NOT_ALLOWED':
      return issue('BUDGET_EXCEEDED', denial.message);
  }
};

const issueForFailure = (failure: RuntimeReadFailure): Issue => {
  if (failure.kind === 'timeout') return issue('TIMEOUT', 'read timed out');
  if (failure.kind === 'rate_limited') {
    return issue('RATE_LIMITED', 'read was rate limited', false, failure.retryAfterMs);
  }
  if (failure.kind === 'argument') return issue('INVALID_ARGUMENT', 'read argument was rejected');
  if (failure.kind === 'reference')
    return issue('UNKNOWN_CANDIDATE', 'read reference was rejected');
  return issue('UPSTREAM_UNAVAILABLE', 'read provider failed');
};

const issueForSingleFlight = (error: RuntimeSingleFlightError): Issue => {
  if (error.code === 'CANCELLED') return issue('CANCELLED', error.message);
  if (error.code === 'STALE_TURN') return issue('STALE_TURN', error.message);
  return issue('INVALID_ARGUMENT', error.message);
};

const retryKindForIssue = (error: Issue): RuntimeReadFailureKind | undefined => {
  if (!error.retryable) return undefined;
  if (error.code === 'TIMEOUT') return 'timeout';
  if (error.code === 'RATE_LIMITED') return 'rate_limited';
  if (error.code === 'UPSTREAM_UNAVAILABLE') return 'transport';
  return undefined;
};

const canonicalJson = (value: unknown, stack = new Set<object>()): string => {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('RUNTIME_READ_FLIGHT_KEY');
    return String(value);
  }
  if (typeof value !== 'object' || stack.has(value)) {
    throw new Error('RUNTIME_READ_FLIGHT_KEY');
  }
  stack.add(value);
  if (Array.isArray(value)) {
    const encoded = `[${value.map((item) => canonicalJson(item, stack)).join(',')}]`;
    stack.delete(value);
    return encoded;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('RUNTIME_READ_FLIGHT_KEY');
  }
  const fields = Object.keys(value)
    .sort()
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new Error('RUNTIME_READ_FLIGHT_KEY');
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, stack)}`;
    });
  stack.delete(value);
  return `{${fields.join(',')}}`;
};

const jsonFlightKey = (value: {
  readonly operation: 'search_places' | 'get_place_details';
  readonly scope: { readonly ownerScopeRef: string; readonly threadId: string };
  readonly context: HarnessContext;
  readonly input: SearchPlacesInput | GetPlaceDetailsInput;
  readonly freshness: GetPlaceDetailsInput['freshness'] | null;
}): string => {
  return canonicalJson(value);
};

const readFlightKey = (
  operation: 'search_places' | 'get_place_details',
  input: SearchPlacesInput | GetPlaceDetailsInput,
  context: HarnessContext,
  freshness: GetPlaceDetailsInput['freshness'] | null,
): string =>
  jsonFlightKey({
    operation,
    scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
    context,
    input,
    freshness,
  });

const toResult = <T>(execution: RuntimeReadExecutionResult<Result<T>>): Result<T> => {
  if (execution.ok) return execution.value;
  if ('denial' in execution) return resultError(issueForDenial(execution.denial));
  if (execution.failure instanceof KnownPortFailure) {
    return resultError(execution.failure.issue);
  }
  return resultError(issueForFailure(execution.failure));
};

const cancellationFor = (
  caller: CancellationToken,
  attemptSignal: AbortSignal,
): CancellationToken => ({
  isCancelled: (): boolean => caller.isCancelled() || attemptSignal.aborted,
});

const executeRead = async <T>(
  executor: RuntimeReadExecutor<Result<T>>,
  request: RuntimeReadExecutionRequest<Result<T>>,
  cancellation: CancellationToken,
): Promise<Result<T>> => {
  if (cancellation.isCancelled()) return resultError(issue('CANCELLED', 'read was cancelled'));
  try {
    const execution = await executor.execute(request);
    if (cancellation.isCancelled()) return resultError(issue('CANCELLED', 'read was cancelled'));
    return toResult(execution);
  } catch (error: unknown) {
    if (error instanceof RuntimeReadPortCancelled) {
      return resultError(issue('CANCELLED', error.message));
    }
    if (error instanceof RuntimeSingleFlightError) {
      return resultError(issueForSingleFlight(error));
    }
    throw error;
  }
};

const wrapPortResult = <T>(value: Result<T>): Result<T> => {
  if (value.status !== 'error') return value;
  const kind = retryKindForIssue(value.error);
  if (kind === undefined) return value;
  throw new KnownPortFailure(kind, value.error);
};

const invokeWithAttemptSignal = async <T>(
  bridge: RuntimeReadAttemptSignalBridge | undefined,
  execution: ToolExecutionContext,
  signal: AbortSignal,
  invoke: () => Promise<T>,
): Promise<T> => {
  const release = bridge?.bind(execution, signal) ?? (() => undefined);
  try {
    return await invoke();
  } finally {
    release();
  }
};

export const createRuntimeReadPorts = (options: RuntimeReadPortOptions): RuntimeReadPorts => {
  const executorOptions = {
    budget: options.budget,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.isStale === undefined ? {} : { isStale: options.isStale }),
  };
  const searchExecutor = new RuntimeReadExecutor<Result<SearchPlacesOutput>>(executorOptions);
  const detailsExecutor = new RuntimeReadExecutor<Result<GetPlaceDetailsOutput>>(executorOptions);

  const search: PlaceSearchPort = {
    search: (input, context, execution, cancellation) => {
      const cost = options.resolveCost({ operation: 'search_places', input, context });
      return executeRead(
        searchExecutor,
        {
          callId: execution.callId,
          flightKey: readFlightKey('search_places', input, context, null),
          operation: 'search_places',
          ...cost,
          invoke: (attemptSignal) => {
            const attemptCancellation = cancellationFor(cancellation, attemptSignal);
            if (attemptCancellation.isCancelled()) throw new RuntimeReadPortCancelled();
            const attemptExecution: ToolExecutionContext = { ...execution };
            return invokeWithAttemptSignal(
              options.attemptSignalBridge,
              attemptExecution,
              attemptSignal,
              async () =>
                options.ports.search
                  .search(input, context, attemptExecution, attemptCancellation)
                  .then(wrapPortResult),
            );
          },
        },
        cancellation,
      );
    },
  };

  const details: PlaceDetailsPort = {
    read: (input, context, execution, cancellation) => {
      const cost = options.resolveCost({ operation: 'get_place_details', input, context });
      return executeRead(
        detailsExecutor,
        {
          callId: execution.callId,
          flightKey: readFlightKey('get_place_details', input, context, input.freshness),
          operation: 'get_place_details',
          ...cost,
          invoke: (attemptSignal) => {
            const attemptCancellation = cancellationFor(cancellation, attemptSignal);
            if (attemptCancellation.isCancelled()) throw new RuntimeReadPortCancelled();
            const attemptExecution: ToolExecutionContext = { ...execution };
            return invokeWithAttemptSignal(
              options.attemptSignalBridge,
              attemptExecution,
              attemptSignal,
              async () =>
                options.ports.details
                  .read(input, context, attemptExecution, attemptCancellation)
                  .then(wrapPortResult),
            );
          },
        },
        cancellation,
      );
    },
  };

  const admission: RuntimeReadPorts['admission'] = {
    reserve: ({ callId, signal }) => {
      const result = options.budget.reserveReadSlot(callId, signal ?? options.signal);
      return result.ok ? result : { ok: false, error: issueForDenial(result.denial) };
    },
    signalFor: (callId) => options.budget.readSignalFor(callId),
    release: (callId) => options.budget.releaseReadSlot(callId),
  };

  return {
    search,
    details,
    admission,
    dispose: (): void => {
      searchExecutor.dispose();
      detailsExecutor.dispose();
    },
  };
};
