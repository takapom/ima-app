import { parseSavedReferencePath } from '@ima/contracts';
import type {
  SavedReferenceRefreshResult,
  SavedReferenceService,
} from '@mobile/services/saved-places/saved-reference-service';
import type { SavedPlaceListService } from '@mobile/services/saved-places/saved-place-list';
import { createMonotonicAssistantResponseClock } from '@mobile/services/assistant-response-clock';
import {
  savedPlacePayloadDeadlinesFor,
  savedPlacePayloadDisplayPolicyBlocked,
  savedPlacePreviewExpiryFor,
  savedPlacePreviewTimerDelay,
} from '@mobile/services/saved-places/saved-place-preview-expiry';
import {
  createSavedPlacePreviewState,
  savedPlacePreviewReducer,
  type SavedPlacePreviewFailure,
  type SavedPlacePreviewPayload,
  type SavedPlacePreviewState,
} from '@mobile/state/saved-place-preview';
import type { ServerSavedPlaceRef } from '@mobile/services/saved-places/saved-place-types';

export type SavedPlacePreviewOptions = {
  /** Omit the list service when SQLite is not available; the hook then stays unavailable. */
  readonly listService?: SavedPlaceListService;
  /** The host supplies the existing threadless saved-reference refresh service. */
  readonly refreshService?: Pick<SavedReferenceService, 'refresh'>;
  /** Use the same host clock as the SQLite projection when expiry is tested or scheduled. */
  readonly now?: () => string;
};

export type SavedPlacePreviewController = {
  readonly getState: () => SavedPlacePreviewState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => void;
  readonly reload: () => void;
  readonly recheck: () => void;
  readonly select: (savedPlaceRef: string, options?: { readonly signal?: AbortSignal }) => boolean;
  readonly close: () => void;
  readonly dispose: () => void;
};

const storageFailure = (): SavedPlacePreviewFailure => ({ reason: 'storage_unavailable' });

const failureFor = (
  result: Extract<SavedReferenceRefreshResult, { readonly status: 'failed' }>,
): SavedPlacePreviewFailure =>
  result.error === undefined
    ? { reason: result.reason }
    : { reason: result.reason, error: result.error };

const payloadFor = (
  result: Extract<SavedReferenceRefreshResult, { readonly status: 'refreshed' }>,
): SavedPlacePreviewPayload => ({
  savedPlaceRef: result.savedPlaceRef,
  candidateId: result.candidateId,
  evidenceIds: result.evidenceIds,
  data: result.data,
});

export const createSavedPlacePreviewController = (
  options: SavedPlacePreviewOptions = {},
): SavedPlacePreviewController => {
  let state = createSavedPlacePreviewState();
  let generation = 0;
  let disposed = false;
  let activeAbort: AbortController | null = null;
  let activeCleanup: (() => void) | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const sourceNow = options.now ?? (() => new Date().toISOString());
  let lastRawMilliseconds: number | null = null;
  let clockInvalid = false;
  const now = createMonotonicAssistantResponseClock(() => {
    if (clockInvalid) throw new Error('SAVED_PLACE_INVALID_CLOCK');
    const value = sourceNow();
    const milliseconds = Date.parse(value);
    if (
      !Number.isFinite(milliseconds) ||
      (lastRawMilliseconds !== null && milliseconds < lastRawMilliseconds)
    ) {
      clockInvalid = true;
      throw new Error('SAVED_PLACE_INVALID_CLOCK');
    }
    lastRawMilliseconds = milliseconds;
    return value;
  });
  let expireNow: () => void = () => undefined;

  const publish = (action: Parameters<typeof savedPlacePreviewReducer>[1]): void => {
    if (disposed) return;
    const next = savedPlacePreviewReducer(state, action);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const clearExpiryTimer = (): void => {
    if (expiryTimer === null) return;
    clearTimeout(expiryTimer);
    expiryTimer = null;
  };

  const cancelActive = (): void => {
    clearExpiryTimer();
    activeCleanup?.();
    activeCleanup = null;
    activeAbort?.abort();
    activeAbort = null;
  };

  const armExpiry = (
    item: SavedPlacePreviewState['selected'],
    operation: number,
    extraDeadlines: readonly (string | null)[] = [],
  ): boolean => {
    clearExpiryTimer();
    const expiry = savedPlacePreviewExpiryFor(item, now, extraDeadlines);
    if (expiry.status === 'invalid') {
      publish({
        type: 'listLoaded',
        result: { status: 'unavailable', reason: 'clock_unavailable' },
      });
      return false;
    }
    if (expiry.expired) {
      expireNow();
      return false;
    }
    if (expiry.nextExpiryMs === null) return true;
    const delay = savedPlacePreviewTimerDelay(expiry);
    if (delay === null) return true;
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      if (
        disposed ||
        generation !== operation ||
        state.selected?.serverSavedPlaceRef !== item?.serverSavedPlaceRef
      ) {
        return;
      }
      const next = savedPlacePreviewExpiryFor(item, now, extraDeadlines);
      if (next.status === 'invalid') {
        cancelActive();
        publish({
          type: 'listLoaded',
          result: { status: 'unavailable', reason: 'clock_unavailable' },
        });
        return;
      }
      if (next.expired) {
        expireNow();
        return;
      }
      armExpiry(item, operation, extraDeadlines);
    }, delay);
    return true;
  };

  const releaseActive = (abort: AbortController): void => {
    if (activeAbort !== abort) return;
    activeCleanup?.();
    activeCleanup = null;
    activeAbort = null;
  };

  const readList = (): void => {
    if (options.listService === undefined) {
      publish({
        type: 'listLoaded',
        result: { status: 'unavailable', reason: 'storage_unavailable' },
      });
      return;
    }
    let result: ReturnType<SavedPlaceListService['list']>;
    try {
      result = options.listService.list();
    } catch {
      result = { status: 'unavailable', reason: 'storage_unavailable' };
    }
    publish({ type: 'listLoaded', result });
  };

  const current = (operation: number, savedPlaceRef: ServerSavedPlaceRef, signal: AbortSignal) =>
    !disposed &&
    generation === operation &&
    !signal.aborted &&
    state.status === 'loading' &&
    state.operation === operation &&
    state.selected?.serverSavedPlaceRef === savedPlaceRef;

  const select = (
    savedPlaceRef: string,
    selectOptions: { readonly signal?: AbortSignal } = {},
  ): boolean => {
    if (disposed || !parseSavedReferencePath({ savedPlaceRef }).success) return false;
    cancelActive();
    const operation = ++generation;
    readList();
    if (state.list.status !== 'available') return false;
    const item = state.list.items.find((entry) => entry.serverSavedPlaceRef === savedPlaceRef);
    if (item === undefined) {
      publish({ type: 'closed', operation });
      return false;
    }

    const abort = new AbortController();
    activeAbort = abort;
    const externalSignal = selectOptions.signal;
    const onExternalAbort = (): void => {
      if (
        disposed ||
        generation !== operation ||
        state.status !== 'loading' ||
        state.operation !== operation ||
        state.selected?.serverSavedPlaceRef !== item.serverSavedPlaceRef
      ) {
        abort.abort();
        return;
      }
      publish({
        type: 'refreshFailed',
        savedPlaceRef: item.serverSavedPlaceRef,
        failure: { reason: 'aborted' },
        operation,
      });
      abort.abort();
      clearExpiryTimer();
      releaseActive(abort);
    };

    publish({ type: 'selectionStarted', item, operation });
    if (!armExpiry(item, operation)) {
      cancelActive();
      return false;
    }
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        onExternalAbort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        activeCleanup = () => externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
    if (externalSignal?.aborted) return true;
    const refreshService = options.refreshService;
    if (refreshService === undefined) {
      publish({
        type: 'refreshFailed',
        savedPlaceRef: item.serverSavedPlaceRef,
        failure: storageFailure(),
        operation,
      });
      releaseActive(abort);
      return true;
    }

    const run = async (): Promise<void> => {
      let result: SavedReferenceRefreshResult;
      try {
        result = await refreshService.refresh({
          savedPlaceRef: item.serverSavedPlaceRef,
          signal: abort.signal,
        });
      } catch {
        result = { status: 'failed', reason: 'api' };
      }
      try {
        if (!current(operation, item.serverSavedPlaceRef, abort.signal)) return;
        const expiry = savedPlacePreviewExpiryFor(item, now);
        if (expiry.status === 'invalid') {
          cancelActive();
          publish({
            type: 'listLoaded',
            result: { status: 'unavailable', reason: 'clock_unavailable' },
          });
          return;
        }
        if (expiry.expired) {
          expireNow();
          return;
        }
        if (result.status === 'refreshed') {
          const payload = payloadFor(result);
          if (savedPlacePayloadDisplayPolicyBlocked(payload, expiry.nowValue)) {
            publish({
              type: 'refreshFailed',
              savedPlaceRef: item.serverSavedPlaceRef,
              failure: { reason: 'retention_denied' },
              operation,
            });
            return;
          }
          if (!armExpiry(item, operation, savedPlacePayloadDeadlinesFor(payload))) return;
          publish({ type: 'refreshSucceeded', payload, operation });
        } else {
          publish({
            type: 'refreshFailed',
            savedPlaceRef: item.serverSavedPlaceRef,
            failure: failureFor(result),
            operation,
          });
        }
      } finally {
        releaseActive(abort);
      }
    };
    void run().catch(() => releaseActive(abort));
    return true;
  };

  const load = (): void => {
    if (disposed) return;
    cancelActive();
    const operation = ++generation;
    publish({ type: 'closed', operation });
    readList();
  };

  expireNow = load;

  const recheck = (): void => {
    if (disposed) return;
    const operation = state.operation;
    readList();
    if (state.list.status !== 'available' || state.selected === null) {
      cancelActive();
      return;
    }
    const extraDeadlines =
      state.payload === null ? [] : savedPlacePayloadDeadlinesFor(state.payload);
    const expiry = savedPlacePreviewExpiryFor(state.selected, now, extraDeadlines);
    if (expiry.status === 'invalid') {
      cancelActive();
      publish({
        type: 'listLoaded',
        result: { status: 'unavailable', reason: 'clock_unavailable' },
      });
      return;
    }
    if (
      expiry.expired ||
      (state.payload !== null &&
        savedPlacePayloadDisplayPolicyBlocked(state.payload, expiry.nowValue))
    ) {
      load();
      return;
    }
    if (state.operation === operation && state.status !== 'closed') {
      armExpiry(state.selected, operation, extraDeadlines);
    }
  };

  const close = (): void => {
    if (disposed) return;
    cancelActive();
    publish({ type: 'closed', operation: ++generation });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    cancelActive();
    listeners.clear();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    reload: load,
    recheck,
    select,
    close,
    dispose,
  };
};
