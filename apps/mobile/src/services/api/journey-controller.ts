import { applyAssistantResponse } from '../../state/assistant-response';
import { advanceAssistantRevision } from '../../state/assistant-response';
import { createApiRequestGate, type ApiOperationToken, type ApiRequestGate } from './request-gate';
import type {
  CreateThreadRequest,
  CreateThreadResponse,
  LifecycleCommand,
  SearchRequest,
  SearchResponse,
  ThreadTurnRequest,
} from '@ima/contracts';
import type {
  JourneyApiController,
  JourneyApiControllerOptions,
  JourneyApiControllerState,
  ActiveResponseOperation,
  LifecycleResult,
  ResponseOperation,
  RetryableResponseOperation,
} from './journey-controller-types';
import { createJourneyHistoryOperations } from './journey-controller-history';
import {
  aborted,
  controllerError,
  failure,
  offline,
  requestIdOf,
  stateForThread,
  validOpaqueId,
} from './journey-controller-support';
import type { ApiRequestOptions, ApiResult, LifecycleResponse } from './types';

export type {
  JourneyApiController,
  JourneyApiControllerOptions,
  JourneyApiControllerState,
  JourneyControllerStatus,
  JourneyLocalRestorePort,
  JourneyLocalRestoreResult,
  JourneyLocalSnapshot,
} from './journey-controller-types';

export const createJourneyApiController = (
  options: JourneyApiControllerOptions,
): JourneyApiController => {
  const gate: ApiRequestGate = createApiRequestGate();
  const listeners = new Set<() => void>();
  const active = new Map<string, ActiveResponseOperation>();
  let retryable: RetryableResponseOperation | null = null;
  let createInFlight: {
    readonly key: string;
    readonly promise: Promise<ApiResult<CreateThreadResponse>>;
  } | null = null;
  let auxiliaryAbort: AbortController | null = null;
  let epoch = 0;
  let disposed = false;
  let state: JourneyApiControllerState = {
    mode: options.api.mode,
    threadId: null,
    responseState: null,
    localSnapshot: null,
    activeTurnId: null,
    status: 'idle',
    error: null,
    lastRequestId: null,
  };

  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const update = (next: JourneyApiControllerState): void => {
    if (disposed) return;
    state = next;
    emit();
  };
  const currentEpoch = (candidate: number): boolean => !disposed && candidate === epoch;
  const abortResponses = (): void => {
    for (const operation of active.values()) operation.abort.abort();
    active.clear();
  };
  const invalidate = (): number => {
    epoch += 1;
    abortResponses();
    auxiliaryAbort?.abort();
    auxiliaryAbort = null;
    retryable = null;
    return epoch;
  };
  const stateFailure = <T>(route: string, requestId: string, issue: string): ApiResult<T> => {
    const error = controllerError(route, issue);
    const result: ApiResult<T> = { ok: false, requestId, error };
    update({ ...state, status: 'error', error, lastRequestId: requestId });
    return result;
  };
  const ensureThread = <T>(
    threadId: string,
    requestId: string,
    route: string,
  ): ApiResult<T> | null =>
    state.threadId === threadId && state.responseState?.threadId === threadId
      ? null
      : stateFailure(route, requestId, 'request thread is not the active conversation');

  const executeResponse = (
    operation: ResponseOperation,
    token: ApiOperationToken,
    operationEpoch: number,
    abort: AbortController,
    cleanup?: () => void,
  ): Promise<ApiResult<SearchResponse>> => {
    const promise = (async (): Promise<ApiResult<SearchResponse>> => {
      let result: ApiResult<SearchResponse>;
      try {
        result =
          operation.kind === 'search'
            ? await options.api.search(operation.input, { signal: abort.signal })
            : await options.api.turn(operation.threadId, operation.input, { signal: abort.signal });
      } catch {
        result = offline(operation.input.requestId);
      }
      if (!currentEpoch(operationEpoch)) {
        return failure(result.requestId, operation.kind, 'late response was ignored');
      }
      if (!result.ok) {
        retryable = { operation, token };
        update({ ...state, status: 'error', error: result.error, lastRequestId: result.requestId });
        return result;
      }
      if (!validOpaqueId(result.data.response.turnId)) {
        return stateFailure(
          operation.kind,
          result.requestId,
          'response turnId is missing or invalid',
        );
      }
      const accepted = gate.accept(token, {
        threadId: result.data.response.threadId,
        turnId: result.data.response.turnId,
        responseId: result.data.response.responseId,
        revision: result.data.response.revision,
      });
      if (!accepted.accepted) {
        return stateFailure(
          operation.kind,
          result.requestId,
          `response was not accepted: ${accepted.reason}`,
        );
      }
      const responseState = state.responseState ?? stateForThread(operation.threadId);
      const nextResponseState = applyAssistantResponse(responseState, result.data.response);
      update({
        ...state,
        responseState: nextResponseState,
        localSnapshot: null,
        activeTurnId: result.data.response.turnId,
        status: 'idle',
        error: null,
        lastRequestId: result.requestId,
      });
      retryable = null;
      return result;
    })();
    const tracked = promise.finally(() => {
      const current = active.get(token.idempotencyKey);
      if (current?.promise === tracked) active.delete(token.idempotencyKey);
      cleanup?.();
    });
    active.set(token.idempotencyKey, {
      operation,
      token,
      abort,
      epoch: operationEpoch,
      promise: tracked,
    });
    return tracked;
  };

  const beginResponse = (
    operation: ResponseOperation,
    requestOptions?: ApiRequestOptions,
  ): Promise<ApiResult<SearchResponse>> => {
    const input = operation.input;
    const requestId = requestIdOf(input);
    if (requestOptions?.signal?.aborted) {
      return Promise.resolve(aborted(requestId));
    }
    const threadError = ensureThread<SearchResponse>(operation.threadId, requestId, operation.kind);
    if (threadError !== null) return Promise.resolve(threadError);
    const token = gate.begin({
      threadId: operation.threadId,
      turnId: input.turnId,
      baseRevision: input.revision,
      idempotencyKey: input.idempotencyKey,
    });
    if (token === null) {
      return Promise.resolve(
        failure(requestId, operation.kind, 'request identity conflicts with an active operation'),
      );
    }
    const prior = active.get(token.idempotencyKey);
    if (prior !== undefined) return prior.promise;
    // A new response supersedes an auxiliary history read. Incrementing the
    // epoch also protects state when an adapter resolves after ignoring abort.
    const operationEpoch = invalidate();
    update({ ...state, status: 'pending', error: null, lastRequestId: requestId });
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    requestOptions?.signal?.addEventListener('abort', onAbort, { once: true });
    return executeResponse(operation, token, operationEpoch, abort, () =>
      requestOptions?.signal?.removeEventListener('abort', onAbort),
    );
  };

  const createThread = (
    input: CreateThreadRequest,
    requestOptions: ApiRequestOptions = {},
  ): Promise<ApiResult<CreateThreadResponse>> => {
    const prior = createInFlight;
    if (prior !== null && prior.key === input.idempotencyKey) return prior.promise;
    if (requestOptions.signal?.aborted) {
      return Promise.resolve(aborted(input.requestId));
    }
    const operationEpoch = invalidate();
    update({ ...state, status: 'creating', error: null, lastRequestId: input.requestId });
    const abort = new AbortController();
    auxiliaryAbort = abort;
    const onAbort = (): void => abort.abort();
    requestOptions.signal?.addEventListener('abort', onAbort, { once: true });
    const promise = (async (): Promise<ApiResult<CreateThreadResponse>> => {
      let result: ApiResult<CreateThreadResponse>;
      try {
        result = await options.api.createThread(input, { signal: abort.signal });
      } catch {
        result = offline(input.requestId);
      }
      if (!currentEpoch(operationEpoch))
        return failure(result.requestId, 'createThread', 'late response was ignored');
      if (!result.ok) {
        update({ ...state, status: 'error', error: result.error, lastRequestId: result.requestId });
        return result;
      }
      gate.selectThread(result.data.threadId, result.data.revision);
      update({
        ...state,
        threadId: result.data.threadId,
        responseState: stateForThread(result.data.threadId, result.data.revision),
        localSnapshot: null,
        activeTurnId: null,
        status: 'idle',
        error: null,
        lastRequestId: result.requestId,
      });
      return result;
    })();
    const tracked = promise.finally(() => {
      if (createInFlight?.promise === tracked) createInFlight = null;
      if (auxiliaryAbort === abort) auxiliaryAbort = null;
      requestOptions.signal?.removeEventListener('abort', onAbort);
    });
    createInFlight = { key: input.idempotencyKey, promise: tracked };
    return tracked;
  };

  const search = (input: SearchRequest, requestOptions?: ApiRequestOptions) =>
    beginResponse({ kind: 'search', threadId: input.threadId, input }, requestOptions);

  const turn = (threadId: string, input: ThreadTurnRequest, requestOptions?: ApiRequestOptions) =>
    beginResponse({ kind: 'turn', threadId, input }, requestOptions);

  const retry = (): Promise<ApiResult<SearchResponse>> => {
    if (retryable === null) {
      return Promise.resolve(failure('controller', 'retry', 'there is no failed request to retry'));
    }
    const nextToken = gate.retry(retryable.token);
    if (nextToken === null) {
      return Promise.resolve(
        failure(requestIdOf(retryable.operation.input), 'retry', 'retry is no longer current'),
      );
    }
    const operationEpoch = ++epoch;
    abortResponses();
    const operation = retryable.operation;
    update({
      ...state,
      status: 'pending',
      error: null,
      lastRequestId: requestIdOf(operation.input),
    });
    return executeResponse(operation, nextToken, operationEpoch, new AbortController());
  };

  const cancel = async (
    threadId: string,
    input: LifecycleCommand,
    requestOptions: ApiRequestOptions = {},
  ): Promise<LifecycleResult> => {
    if (requestOptions.signal?.aborted) return aborted(input.requestId);
    const threadError = ensureThread<LifecycleResponse>(threadId, input.requestId, 'cancel');
    if (threadError !== null) return threadError;
    const operationsToCancel = [...active.values()];
    const operationEpoch = invalidate();
    for (const operation of operationsToCancel) {
      if (operation.operation.threadId === threadId) gate.cancel(operation.token);
    }
    update({ ...state, status: 'cancelling', error: null, lastRequestId: input.requestId });
    const abort = new AbortController();
    auxiliaryAbort = abort;
    if (requestOptions.signal?.aborted) {
      abort.abort();
    }
    const onAbort = (): void => abort.abort();
    requestOptions.signal?.addEventListener('abort', onAbort, { once: true });
    let result: LifecycleResult;
    try {
      result = await options.api.lifecycle('cancel', threadId, input, { signal: abort.signal });
    } catch {
      result = offline(input.requestId);
    }
    const cleanup = (): void => {
      if (auxiliaryAbort === abort) auxiliaryAbort = null;
      requestOptions.signal?.removeEventListener('abort', onAbort);
    };
    if (!currentEpoch(operationEpoch)) {
      cleanup();
      return failure(result.requestId, 'cancel', 'late response was ignored');
    }
    cleanup();
    if (!result.ok) {
      update({ ...state, status: 'error', error: result.error, lastRequestId: result.requestId });
      return result;
    }
    gate.selectThread(threadId, result.data.revision);
    const responseState = state.responseState ?? stateForThread(threadId);
    update({
      ...state,
      responseState: advanceAssistantRevision(responseState, result.data.revision),
      activeTurnId: result.data.turnId,
      status: 'cancelled',
      error: null,
      lastRequestId: result.requestId,
    });
    return result;
  };

  const history = createJourneyHistoryOperations({
    options,
    gate,
    getState: () => state,
    update,
    invalidate,
    currentEpoch,
    trackAuxiliaryAbort: (abort) => {
      auxiliaryAbort = abort;
    },
    clearAuxiliaryAbort: (abort) => {
      if (auxiliaryAbort === abort) auxiliaryAbort = null;
    },
  });

  const cancelPending = (): void => {
    invalidate();
    update({ ...state, status: 'cancelled', error: null });
  };

  const reset = (): void => {
    invalidate();
    update({
      ...state,
      threadId: null,
      responseState: null,
      localSnapshot: null,
      activeTurnId: null,
      status: 'idle',
      error: null,
      lastRequestId: null,
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    epoch += 1;
    abortResponses();
    auxiliaryAbort?.abort();
    auxiliaryAbort = null;
    createInFlight = null;
    listeners.clear();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createThread,
    search,
    turn,
    retry,
    cancel,
    readThread: (threadId, requestOptions) =>
      history.loadThread(threadId, 'readThread', requestOptions),
    replayThread: (threadId, requestOptions) =>
      history.loadThread(threadId, 'replayThread', requestOptions),
    restoreLocal: history.restoreLocal,
    cancelPending,
    reset,
    dispose,
  };
};
