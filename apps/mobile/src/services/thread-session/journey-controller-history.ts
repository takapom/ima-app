import { applyThreadSnapshotJson } from '../assistant-response';
import { type ApiRequestGate } from './request-gate';
import type {
  JourneyApiControllerOptions,
  JourneyApiControllerState,
  JourneyLocalRestoreResult,
  JourneyLocalSnapshot,
} from './journey-controller-types';
import {
  controllerError,
  latestTurnId,
  offline,
  stateForThread,
  validLocalSnapshot,
  validOpaqueId,
} from './journey-controller-support';
import type { ApiRequestOptions, ApiResult } from '../api/api';
import type { ThreadReadResponse } from '@ima/contracts';

type HistoryDependencies = {
  readonly options: JourneyApiControllerOptions;
  readonly gate: ApiRequestGate;
  readonly getState: () => JourneyApiControllerState;
  readonly update: (state: JourneyApiControllerState) => void;
  readonly invalidate: () => number;
  readonly currentEpoch: (epoch: number) => boolean;
  readonly trackAuxiliaryAbort: (abort: AbortController) => void;
  readonly clearAuxiliaryAbort: (abort: AbortController) => void;
};

export type JourneyHistoryOperations = {
  readonly loadThread: (
    threadId: string,
    kind: 'readThread' | 'replayThread',
    requestOptions?: ApiRequestOptions,
  ) => Promise<ApiResult<ThreadReadResponse>>;
  readonly restoreLocal: (threadId: string) => Promise<JourneyLocalRestoreResult>;
};

export const createJourneyHistoryOperations = (
  dependencies: HistoryDependencies,
): JourneyHistoryOperations => {
  const {
    options,
    gate,
    getState,
    update,
    invalidate,
    currentEpoch,
    trackAuxiliaryAbort,
    clearAuxiliaryAbort,
  } = dependencies;

  const loadThread = async (
    threadId: string,
    kind: 'readThread' | 'replayThread',
    requestOptions: ApiRequestOptions = {},
  ): Promise<ApiResult<ThreadReadResponse>> => {
    if (!validOpaqueId(threadId)) {
      const error = controllerError(kind, 'invalid thread ID');
      update({ ...getState(), status: 'error', error, lastRequestId: 'controller' });
      return { ok: false, requestId: 'controller', error };
    }
    if (requestOptions.signal?.aborted)
      return { ok: false, requestId: 'controller', error: { kind: 'aborted' } };
    const operationEpoch = invalidate();
    const current = getState();
    const responseState =
      current.threadId === threadId && current.responseState !== null
        ? current.responseState
        : stateForThread(threadId);
    gate.selectThread(threadId, responseState.revision);
    update({
      ...current,
      threadId,
      responseState,
      localSnapshot: current.threadId === threadId ? current.localSnapshot : null,
      activeTurnId: null,
      status: kind === 'readThread' ? 'reading' : 'replaying',
      error: null,
    });
    const abort = new AbortController();
    trackAuxiliaryAbort(abort);
    if (requestOptions.signal?.aborted) abort.abort();
    const onAbort = (): void => abort.abort();
    requestOptions.signal?.addEventListener('abort', onAbort, { once: true });
    let result: ApiResult<ThreadReadResponse>;
    try {
      result =
        kind === 'readThread'
          ? await options.api.readThread(threadId, { signal: abort.signal })
          : await options.api.replayThread(threadId, { signal: abort.signal });
    } catch {
      result = offline('controller');
    }
    const cleanup = (): void => {
      clearAuxiliaryAbort(abort);
      requestOptions.signal?.removeEventListener('abort', onAbort);
    };
    if (!currentEpoch(operationEpoch)) {
      cleanup();
      return {
        ok: false,
        requestId: result.requestId,
        error: {
          kind: 'contract',
          route: kind,
          issues: ['late response was ignored'],
          status: null,
        },
      };
    }
    cleanup();
    if (!result.ok) {
      update({
        ...getState(),
        status: 'error',
        error: result.error,
        lastRequestId: result.requestId,
      });
      return result;
    }
    const currentAfterRead = getState();
    const sameThread =
      currentAfterRead.threadId === threadId && currentAfterRead.responseState !== null;
    const currentRevision = sameThread ? currentAfterRead.responseState.revision : 0;
    if (result.data.revision < currentRevision) {
      const staleError = controllerError(
        kind,
        'history snapshot is older than the current response',
      );
      const readingStatus = kind === 'readThread' ? 'reading' : 'replaying';
      const stateAfterStale = getState();
      update({
        ...stateAfterStale,
        ...(stateAfterStale.status === readingStatus
          ? { status: 'error' as const, error: staleError }
          : {}),
        lastRequestId: result.requestId,
      });
      return {
        ok: false,
        requestId: result.requestId,
        error: staleError,
      };
    }
    const baseState =
      sameThread && currentAfterRead.localSnapshot === null
        ? currentAfterRead.responseState
        : stateForThread(threadId);
    const applied = applyThreadSnapshotJson(baseState, result.data);
    if (!applied.accepted) {
      const error = controllerError(kind, applied.issues.join('; '));
      update({ ...getState(), status: 'error', error, lastRequestId: result.requestId });
      return { ok: false, requestId: result.requestId, error };
    }
    gate.selectThread(threadId, result.data.revision);
    update({
      ...currentAfterRead,
      responseState: applied.state,
      localSnapshot: null,
      activeTurnId: latestTurnId(applied.state),
      status: 'idle',
      error: null,
      lastRequestId: result.requestId,
    });
    return result;
  };

  const restoreLocal = async (threadId: string): Promise<JourneyLocalRestoreResult> => {
    const operationEpoch = invalidate();
    gate.selectThread(threadId, 0);
    update({
      ...getState(),
      threadId,
      responseState: stateForThread(threadId),
      localSnapshot: null,
      activeTurnId: null,
      status: 'reading',
      error: null,
    });
    if (options.localRestore === undefined) {
      const error = controllerError('restoreLocal', 'local restore is unavailable');
      update({ ...getState(), status: 'error', error });
      return { status: 'unavailable', reason: 'not_configured' };
    }
    let snapshot: JourneyLocalSnapshot | null;
    try {
      snapshot = await options.localRestore.readSnapshot(threadId);
    } catch {
      if (currentEpoch(operationEpoch)) {
        const error = controllerError('restoreLocal', 'local restore could not be read');
        update({ ...getState(), status: 'error', error });
      }
      return { status: 'unavailable', reason: 'read_failed' };
    }
    if (!currentEpoch(operationEpoch)) return { status: 'unavailable', reason: 'read_failed' };
    if (snapshot === null) {
      update({ ...getState(), status: 'idle', error: null });
      return { status: 'empty' };
    }
    let now: string;
    try {
      now = options.clock?.() ?? new Date().toISOString();
    } catch {
      now = '';
    }
    if (!validLocalSnapshot(snapshot, threadId, now)) {
      const error = controllerError('restoreLocal', 'local snapshot failed validation');
      update({ ...getState(), status: 'error', error });
      return { status: 'unavailable', reason: 'read_failed' };
    }
    gate.selectThread(threadId, snapshot.revision);
    update({
      ...getState(),
      responseState: stateForThread(threadId, snapshot.revision),
      localSnapshot: snapshot,
      status: 'idle',
      error: null,
    });
    return { status: 'restored', snapshot };
  };

  return { loadThread, restoreLocal };
};
