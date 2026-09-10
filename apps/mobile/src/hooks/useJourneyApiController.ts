import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CreateThreadResponse, SearchResponse } from '@ima/contracts';
import type { JourneyApiControllerState } from '../services/api/journey-controller';
import type {
  JourneyApiControllerBinding,
  JourneyApiSubmitContext,
} from '../services/api/journey-api-binding';
import type { ApiError, ApiResult, LifecycleResponse } from '../services/api/types';
import {
  awaitRetryIfCurrent,
  retryCreatedThreadThenSearchIfCurrent,
  restoreThenReadIfCurrent,
  releaseJourneyApiController,
  submissionScopeMatches,
} from './journey-api-operation-flow';

export type {
  JourneyApiCancelFactoryInput,
  JourneyApiControllerBinding,
  JourneyApiRequestFactory,
  JourneyApiSearchFactoryInput,
  JourneyApiSubmitContext,
  JourneyApiTurnFactoryInput,
  JourneySavedPlacePreviewBinding,
} from '../services/api/journey-api-binding';

export {
  awaitRetryIfCurrent,
  operationStillCurrent,
  retryCreatedThreadThenSearchIfCurrent,
  releaseJourneyApiController,
  restoreThenReadIfCurrent,
  submissionScopeMatches,
} from './journey-api-operation-flow';

export type JourneyApiRequestStatus = 'idle' | 'pending' | 'error' | 'cancelled';

export type JourneyApiHookResult = {
  readonly connected: boolean;
  /** Increments when the selected history/new-search view must reset shell-local state. */
  readonly viewKey: number;
  readonly state: JourneyApiControllerState;
  readonly responseState: JourneyApiControllerState['responseState'];
  readonly requestStatus: JourneyApiRequestStatus;
  readonly errorMessage: string | null;
  readonly submit: (
    query: string,
    context: JourneyApiSubmitContext,
  ) => Promise<ApiResult<CreateThreadResponse> | ApiResult<SearchResponse>>;
  readonly retry: () => Promise<ApiResult<CreateThreadResponse> | ApiResult<SearchResponse>>;
  readonly cancel: () => Promise<ApiResult<LifecycleResponse> | ApiResult<never>>;
  readonly selectHistory: (threadId: string) => Promise<void>;
  readonly replay: (threadId: string) => Promise<void>;
  readonly reportUnexpected: () => void;
  readonly reset: () => void;
};

const emptyState: JourneyApiControllerState = {
  mode: 'fixture',
  threadId: null,
  responseState: null,
  localSnapshot: null,
  activeTurnId: null,
  status: 'idle',
  error: null,
  lastRequestId: null,
};

const noSubscribe = (): (() => void) => () => undefined;
const noSnapshot = (): JourneyApiControllerState => emptyState;

export const requestStatusFor = (
  status: JourneyApiControllerState['status'],
): JourneyApiRequestStatus => {
  if (
    status === 'creating' ||
    status === 'pending' ||
    status === 'cancelling' ||
    status === 'reading' ||
    status === 'replaying'
  ) {
    return 'pending';
  }
  if (status === 'error') return 'error';
  if (status === 'cancelled') return 'cancelled';
  return 'idle';
};

export const journeyApiErrorMessage = (error: ApiError | null): string | null => {
  if (error === null) return null;
  if (error.kind === 'aborted') return '検索を取り消しました。';
  if (error.kind === 'timeout') return '応答に時間がかかっています。もう一度試してください。';
  if (error.kind === 'offline') return '接続できませんでした。通信状態を確認してください。';
  if (error.kind === 'credentials') return '接続設定を確認してから、もう一度試してください。';
  if (error.kind === 'configuration') return '検索を開始できません。アプリ設定を確認してください。';
  if (error.kind === 'http' && (error.status === 401 || error.status === 403)) {
    return '接続を確認してから、もう一度試してください。';
  }
  if (error.kind === 'http' && error.status === 429) {
    return 'ただいま混み合っています。少し待ってから再試行してください。';
  }
  if (error.kind === 'http' && error.status >= 500) {
    return 'サービスに接続できませんでした。少し待ってから再試行してください。';
  }
  return '応答を確認できませんでした。もう一度試してください。';
};

type LastSubmission = {
  readonly query: string;
  readonly context: JourneyApiSubmitContext;
  readonly threadId: string | null;
};

const rejectedUnavailable = (): ApiResult<never> => ({
  ok: false,
  requestId: 'controller',
  error: { kind: 'offline' },
});

const rejectedAborted = <T>(): ApiResult<T> => ({
  ok: false,
  requestId: 'controller',
  error: { kind: 'aborted' },
});

export const useJourneyApiController = (
  binding?: JourneyApiControllerBinding,
): JourneyApiHookResult => {
  const controller = binding?.controller;
  const requests = binding?.requests;
  const state = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getState ?? noSnapshot,
    noSnapshot,
  );
  const connected = controller !== undefined && requests !== undefined;
  const [requestState, setRequestState] = useState<LastSubmission | null>(null);
  const [boundaryError, setBoundaryError] = useState<string | null>(null);
  const [viewKey, setViewKey] = useState(0);
  const operationGeneration = useRef(0);
  const reportUnexpected = useCallback((): void => {
    setBoundaryError('検索を開始できません。もう一度試してください。');
  }, []);

  useEffect(() => {
    if (!controller) return undefined;
    return () => {
      operationGeneration.current += 1;
      releaseJourneyApiController(controller);
    };
  }, [controller]);

  const submit = useCallback(
    async (
      query: string,
      context: JourneyApiSubmitContext,
    ): Promise<ApiResult<CreateThreadResponse> | ApiResult<SearchResponse>> => {
      if (!controller || !requests) return rejectedUnavailable();
      const current = controller.getState();
      if (
        current.status === 'creating' ||
        current.status === 'pending' ||
        current.status === 'cancelling' ||
        current.status === 'reading' ||
        current.status === 'replaying'
      ) {
        return rejectedAborted<SearchResponse>();
      }
      const generation = ++operationGeneration.current;
      setBoundaryError(null);
      setRequestState({ query, context, threadId: current.threadId });
      if (current.threadId === null) {
        const created = await controller.createThread(requests.createThread());
        if (generation !== operationGeneration.current)
          return rejectedAborted<CreateThreadResponse>();
        if (!created.ok) return created;
        setRequestState({ query, context, threadId: created.data.threadId });
        const search = requests.search({
          threadId: created.data.threadId,
          revision: created.data.revision,
          query,
          context,
        });
        const result = await controller.search(search);
        return generation === operationGeneration.current
          ? result
          : rejectedAborted<SearchResponse>();
      }
      const revision = current.responseState?.revision ?? 0;
      if (revision === 0) {
        const result = await controller.search(
          requests.search({
            threadId: current.threadId,
            revision,
            query,
            context,
          }),
        );
        return generation === operationGeneration.current
          ? result
          : rejectedAborted<SearchResponse>();
      }
      const result = await controller.turn(
        current.threadId,
        requests.turn({
          threadId: current.threadId,
          revision,
          turnId: current.activeTurnId,
          query,
          context,
        }),
      );
      return generation === operationGeneration.current
        ? result
        : rejectedAborted<SearchResponse>();
    },
    [controller, requests],
  );

  const retry = useCallback(async (): Promise<
    ApiResult<CreateThreadResponse> | ApiResult<SearchResponse>
  > => {
    if (!controller || !requests) return rejectedUnavailable();
    const generation = ++operationGeneration.current;
    setBoundaryError(null);
    const last = requestState;
    const before = controller.getState();
    const retryingCreate = last !== null && last.threadId === null && before.threadId === null;
    if (
      !retryingCreate &&
      last !== null &&
      !submissionScopeMatches(last.threadId, before.threadId)
    ) {
      return rejectedAborted<SearchResponse>();
    }
    const startedThreadId = last?.threadId ?? before.threadId;
    if (retryingCreate && last !== null) {
      const retried = await retryCreatedThreadThenSearchIfCurrent(
        generation,
        () => ({
          generation: operationGeneration.current,
          threadId: controller.getState().threadId,
        }),
        () => controller.retry(),
        (created) => {
          setRequestState({ ...last, threadId: created.threadId });
          return controller.search(
            requests.search({
              threadId: created.threadId,
              revision: created.revision,
              query: last.query,
              context: last.context,
            }),
          );
        },
      );
      return retried.current ? retried.result : rejectedAborted<SearchResponse>();
    }
    const retried = await awaitRetryIfCurrent(
      generation,
      startedThreadId,
      () => ({
        generation: operationGeneration.current,
        threadId: controller.getState().threadId,
      }),
      () => controller.retry(),
    );
    if (!retried.current) {
      return rejectedAborted<SearchResponse>();
    }
    if (generation !== operationGeneration.current) return rejectedAborted<SearchResponse>();
    return retried.result;
  }, [controller, requests, requestState]);

  const cancel = useCallback(async (): Promise<ApiResult<LifecycleResponse> | ApiResult<never>> => {
    if (!controller || !requests) return rejectedUnavailable();
    ++operationGeneration.current;
    setBoundaryError(null);
    const current = controller.getState();
    if (current.threadId === null) {
      controller.cancelPending();
      return { ok: false, requestId: 'controller', error: { kind: 'aborted' } };
    }
    return controller.cancel(
      current.threadId,
      requests.cancel({
        threadId: current.threadId,
        revision: current.responseState?.revision ?? 0,
        turnId: current.activeTurnId,
      }),
    );
  }, [controller, requests]);

  const selectHistory = useCallback(
    async (threadId: string): Promise<void> => {
      if (!controller) return;
      const generation = ++operationGeneration.current;
      setBoundaryError(null);
      setRequestState(null);
      setViewKey((current) => current + 1);
      await restoreThenReadIfCurrent(
        controller,
        threadId,
        () => generation === operationGeneration.current,
      );
    },
    [controller],
  );

  const replay = useCallback(
    async (threadId: string): Promise<void> => {
      if (!controller) return;
      ++operationGeneration.current;
      setBoundaryError(null);
      await controller.replayThread(threadId);
    },
    [controller],
  );

  const reset = useCallback((): void => {
    ++operationGeneration.current;
    controller?.reset();
    setViewKey((current) => current + 1);
    setBoundaryError(null);
    setRequestState(null);
  }, [controller]);

  return {
    connected,
    viewKey,
    state,
    responseState: state.responseState,
    requestStatus: requestStatusFor(state.status),
    errorMessage: boundaryError ?? journeyApiErrorMessage(state.error),
    submit,
    retry,
    cancel,
    selectHistory,
    replay,
    reportUnexpected,
    reset,
  };
};
