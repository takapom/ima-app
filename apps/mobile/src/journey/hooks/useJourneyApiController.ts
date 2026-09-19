import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CreateThreadResponse, LocationSnapshot, SearchResponse } from '@ima/contracts';
import type { JourneyApiControllerState } from '@mobile/journey/services/thread-session/journey-controller';
import type {
  JourneyApiControllerBinding,
  JourneyApiSubmitContext,
} from '@mobile/journey/services/thread-session/journey-api-binding';
import type { ApiError, ApiResult, LifecycleResponse } from '@mobile/platform/http/api';
import {
  awaitRetryIfCurrent,
  retryCreatedThreadThenSearchIfCurrent,
  restoreThenReadIfCurrent,
  releaseJourneyApiController,
  submissionScopeMatches,
} from '@mobile/journey/hooks/journey-api-operation-flow';
import {
  locationDraftScopeMatches,
  prepareJourneyLocation,
  unavailableJourneyLocation,
  type JourneyLocationDraft,
} from '@mobile/journey/hooks/journey-location-operation';

export type {
  JourneyApiCancelFactoryInput,
  JourneyApiControllerBinding,
  JourneyApiRequestFactory,
  JourneyApiSearchFactoryInput,
  JourneyApiSubmitContext,
  JourneyApiTurnFactoryInput,
  JourneySavedPlacePreviewBinding,
} from '@mobile/journey/services/thread-session/journey-api-binding';

export {
  awaitRetryIfCurrent,
  operationStillCurrent,
  retryCreatedThreadThenSearchIfCurrent,
  releaseJourneyApiController,
  restoreThenReadIfCurrent,
  submissionScopeMatches,
} from '@mobile/journey/hooks/journey-api-operation-flow';

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

const requestStatusFor = (
  status: JourneyApiControllerState['status'],
  locationPending = false,
): JourneyApiRequestStatus => {
  if (locationPending) return 'pending';
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
  // The turn ran but could not finish a proposal. Say so instead of blaming the connection.
  if (error.kind === 'http' && error.publicError.code === 'BUDGET_EXCEEDED') {
    return '今回は候補をまとめきれませんでした。条件を絞ってもう一度試してください。';
  }
  if (error.kind === 'http' && error.publicError.code === 'MIXED_TERMINAL_ACTION') {
    return '応答をまとめきれませんでした。もう一度試してください。';
  }
  if (error.kind === 'http' && error.status === 504) {
    return '応答に時間がかかっています。もう一度試してください。';
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
  readonly location: LocationSnapshot;
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
  const [locationPending, setLocationPending] = useState(false);
  const locationPendingRef = useRef(false);
  const locationAbortRef = useRef<AbortController | null>(null);
  const locationDraftRef = useRef<JourneyLocationDraft | null>(null);
  const operationGeneration = useRef(0);
  const locationService = binding?.location;
  const reportUnexpected = useCallback((): void => {
    setBoundaryError('検索を開始できません。もう一度試してください。');
  }, []);

  const abortLocation = useCallback((): void => {
    locationAbortRef.current?.abort();
    locationAbortRef.current = null;
    locationPendingRef.current = false;
    setLocationPending(false);
  }, []);

  const acquireLocation = useCallback(
    (generation: number): LocationSnapshot | Promise<LocationSnapshot | null> => {
      if (locationService === undefined) {
        return unavailableJourneyLocation();
      }
      locationAbortRef.current?.abort();
      const abort = new AbortController();
      locationAbortRef.current = abort;
      locationPendingRef.current = true;
      setLocationPending(true);
      return (async (): Promise<LocationSnapshot | null> => {
        const preparation = await prepareJourneyLocation(locationService, abort.signal);
        if (locationAbortRef.current === abort) {
          locationAbortRef.current = null;
          locationPendingRef.current = false;
          setLocationPending(false);
        }
        if (
          locationAbortRef.current !== null ||
          generation !== operationGeneration.current ||
          preparation.kind === 'cancelled'
        ) {
          return null;
        }
        return preparation.snapshot;
      })();
    },
    [locationService],
  );

  useEffect(() => {
    return () => {
      operationGeneration.current += 1;
      abortLocation();
      locationDraftRef.current = null;
    };
  }, [abortLocation, locationService]);

  useEffect(() => {
    if (!controller) return undefined;
    return () => {
      operationGeneration.current += 1;
      abortLocation();
      locationDraftRef.current = null;
      releaseJourneyApiController(controller);
    };
  }, [abortLocation, controller]);

  const submit = useCallback(
    async (
      query: string,
      context: JourneyApiSubmitContext,
    ): Promise<ApiResult<CreateThreadResponse> | ApiResult<SearchResponse>> => {
      if (!controller || !requests) return rejectedUnavailable();
      const current = controller.getState();
      if (
        locationPendingRef.current ||
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
      const startedThreadId = current.threadId;
      const startedRevision = current.responseState?.revision ?? 0;
      const startedTurnId = current.activeTurnId;
      locationDraftRef.current = {
        query,
        context,
        threadId: startedThreadId,
        revision: startedRevision,
        turnId: startedTurnId,
      };
      const locationResult = acquireLocation(generation);
      const location = locationResult instanceof Promise ? await locationResult : locationResult;
      if (location === null || generation !== operationGeneration.current) {
        return rejectedAborted<SearchResponse>();
      }
      const currentAfterLocation = controller.getState();
      if (
        currentAfterLocation.status === 'creating' ||
        currentAfterLocation.status === 'pending' ||
        currentAfterLocation.status === 'cancelling' ||
        currentAfterLocation.status === 'reading' ||
        currentAfterLocation.status === 'replaying'
      ) {
        locationDraftRef.current = null;
        return rejectedAborted<SearchResponse>();
      }
      if (
        currentAfterLocation.threadId !== startedThreadId ||
        (currentAfterLocation.responseState?.revision ?? 0) !== startedRevision ||
        currentAfterLocation.activeTurnId !== startedTurnId
      ) {
        locationDraftRef.current = null;
        return rejectedAborted<SearchResponse>();
      }
      locationDraftRef.current = null;
      setRequestState({
        query,
        context,
        threadId: currentAfterLocation.threadId,
        location,
      });
      if (currentAfterLocation.threadId === null) {
        const created = await controller.createThread(requests.createThread());
        if (generation !== operationGeneration.current)
          return rejectedAborted<CreateThreadResponse>();
        if (!created.ok) return created;
        setRequestState({ query, context, threadId: created.data.threadId, location });
        const search = requests.search({
          threadId: created.data.threadId,
          revision: created.data.revision,
          query,
          context,
          location,
        });
        const result = await controller.search(search);
        return generation === operationGeneration.current
          ? result
          : rejectedAborted<SearchResponse>();
      }
      const revision = currentAfterLocation.responseState?.revision ?? 0;
      if (revision === 0) {
        const result = await controller.search(
          requests.search({
            threadId: currentAfterLocation.threadId,
            revision,
            query,
            context,
            location,
          }),
        );
        return generation === operationGeneration.current
          ? result
          : rejectedAborted<SearchResponse>();
      }
      const result = await controller.turn(
        currentAfterLocation.threadId,
        requests.turn({
          threadId: currentAfterLocation.threadId,
          revision,
          turnId: currentAfterLocation.activeTurnId,
          query,
          context,
          location,
        }),
      );
      return generation === operationGeneration.current
        ? result
        : rejectedAborted<SearchResponse>();
    },
    [acquireLocation, controller, requests],
  );

  const retry = useCallback(async (): Promise<
    ApiResult<CreateThreadResponse> | ApiResult<SearchResponse>
  > => {
    if (!controller || !requests) return rejectedUnavailable();
    if (locationPendingRef.current) return rejectedAborted<SearchResponse>();
    const locationDraft = locationDraftRef.current;
    if (locationDraft !== null) {
      const current = controller.getState();
      if (
        !locationDraftScopeMatches(locationDraft, {
          threadId: current.threadId,
          revision: current.responseState?.revision ?? 0,
          turnId: current.activeTurnId,
        })
      ) {
        locationDraftRef.current = null;
        return rejectedAborted<SearchResponse>();
      }
      return submit(locationDraft.query, locationDraft.context);
    }
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
              location: last.location,
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
  }, [controller, requests, requestState, submit]);

  const cancel = useCallback(async (): Promise<ApiResult<LifecycleResponse> | ApiResult<never>> => {
    if (!controller || !requests) return rejectedUnavailable();
    const locationWasPending = locationPendingRef.current;
    ++operationGeneration.current;
    abortLocation();
    setBoundaryError(null);
    const current = controller.getState();
    if (locationWasPending) {
      controller.cancelPending();
      return { ok: false, requestId: 'controller', error: { kind: 'aborted' } };
    }
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
  }, [abortLocation, controller, requests]);

  const selectHistory = useCallback(
    async (threadId: string): Promise<void> => {
      if (!controller) return;
      const generation = ++operationGeneration.current;
      abortLocation();
      locationDraftRef.current = null;
      setBoundaryError(null);
      setRequestState(null);
      setViewKey((current) => current + 1);
      await restoreThenReadIfCurrent(
        controller,
        threadId,
        () => generation === operationGeneration.current,
      );
    },
    [abortLocation, controller],
  );

  const reset = useCallback((): void => {
    ++operationGeneration.current;
    abortLocation();
    locationDraftRef.current = null;
    controller?.reset();
    setViewKey((current) => current + 1);
    setBoundaryError(null);
    setRequestState(null);
  }, [abortLocation, controller]);

  return {
    connected,
    viewKey,
    state,
    responseState: state.responseState,
    requestStatus: requestStatusFor(state.status, locationPending),
    errorMessage: boundaryError ?? journeyApiErrorMessage(state.error),
    submit,
    retry,
    cancel,
    selectHistory,
    reportUnexpected,
    reset,
  };
};
