import type { ResponseResumeSubscription } from './assistant-response-clock';
import { subscribeToAssistantResponseResume } from './assistant-response-clock';
import {
  createJourneyHistoryService,
  type JourneyHistoryItem,
  type JourneyHistoryResult,
  type JourneyHistoryService,
} from './journey-history';
import type { OwnerPrefsClient } from './api/owner-client';
import type { JourneyApiController } from './thread-session/journey-controller-types';
import { createOwnerPrefsProjection } from './owner-prefs-projection';
import { createJourneyPreferencesService, type JourneyPreferencesService } from './preferences';
import { createRuntimeId } from './runtime-id';
import type { SqliteStore } from './sqlite/types';

export type NativeJourneyPersistenceScheduler = {
  readonly schedule: (callback: () => void, delayMilliseconds: number) => unknown;
  readonly cancel: (handle: unknown) => void;
};

export type NativeJourneyPersistenceOptions = {
  /** One verified runtime database. The service never chooses a database itself. */
  readonly sqlite?: NativeJourneyPersistenceStorage | null;
  /** Controller updates can create or expire history rows. */
  readonly controller?: Pick<JourneyApiController, 'subscribe'>;
  /** The same clock used by the runtime SQLite store, when available. */
  readonly now?: () => string;
  /** Injected AppState-style source; production hooks adapt React Native AppState. */
  readonly subscribeForeground?: ResponseResumeSubscription;
  /** Injectable scheduler keeps the expiry boundary deterministic in unit tests. */
  readonly scheduler?: NativeJourneyPersistenceScheduler;
  /** Opaque verified scope used to reject stale snapshots when a host switches owners. */
  readonly scope?: string | null;
  /** OwnerStore HTTP client; when present, SQLite prefs/saved are a projection. */
  readonly ownerClient?: OwnerPrefsClient;
  readonly requestIdFactory?: () => string;
};

export type NativeJourneyPersistenceStorage = Pick<
  SqliteStore,
  'listThreads' | 'readPreferences' | 'savePreferences'
> &
  Partial<Pick<SqliteStore, 'listSavedPlaces' | 'savePlace' | 'deleteSavedPlace' | 'markDecided'>>;

export type NativeJourneyPersistenceSnapshot = {
  readonly scope: string | null;
  readonly historyStatus: 'loading' | 'available' | 'unavailable';
  readonly historyUnavailable: boolean;
  readonly history: readonly JourneyHistoryItem[];
  readonly nextExpiryAt: string | null;
  readonly historyResult: JourneyHistoryResult | null;
};

export type NativeJourneyPersistence = {
  readonly preferences: JourneyPreferencesService | undefined;
  readonly historyService: JourneyHistoryService;
  readonly getSnapshot: () => NativeJourneyPersistenceSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** Starts controller, foreground, and expiry-boundary subscriptions. */
  readonly activate: () => () => void;
  readonly refresh: () => void;
  readonly dispose: () => void;
};

type TimerHandle = ReturnType<typeof setTimeout>;

const nativeScheduler: NativeJourneyPersistenceScheduler = {
  schedule: (callback, delayMilliseconds) => setTimeout(callback, delayMilliseconds),
  cancel: (handle) => clearTimeout(handle as TimerHandle),
};

const nativeNow = (): string => new Date().toISOString();
const noop = (): void => undefined;

const unavailableHistory = (): JourneyHistoryResult => ({
  status: 'unavailable',
  reason: 'storage_unavailable',
});

const snapshotFor = (
  scope: string | null,
  result: JourneyHistoryResult | null,
): NativeJourneyPersistenceSnapshot => ({
  scope,
  historyStatus: result === null ? 'loading' : result.status,
  historyUnavailable: result?.status === 'unavailable',
  history: result?.status === 'available' ? result.items : [],
  nextExpiryAt: result?.status === 'available' ? result.nextExpiryAt : null,
  historyResult: result,
});

const historyEqual = (
  left: readonly JourneyHistoryItem[],
  right: readonly JourneyHistoryItem[],
): boolean =>
  left.length === right.length &&
  left.every((item, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      item.id === candidate.id &&
      item.label === candidate.label &&
      item.query === candidate.query &&
      item.time === candidate.time
    );
  });

const snapshotEqual = (
  left: NativeJourneyPersistenceSnapshot,
  right: NativeJourneyPersistenceSnapshot,
): boolean =>
  left.scope === right.scope &&
  left.historyStatus === right.historyStatus &&
  left.historyUnavailable === right.historyUnavailable &&
  historyEqual(left.history, right.history) &&
  left.nextExpiryAt === right.nextExpiryAt &&
  (left.historyResult?.status ?? null) === (right.historyResult?.status ?? null) &&
  (left.historyResult?.status !== 'unavailable' ||
    right.historyResult?.status !== 'unavailable' ||
    left.historyResult.reason === right.historyResult.reason);

const safeUnsubscribe = (unsubscribe: (() => void) | undefined): void => {
  try {
    unsubscribe?.();
  } catch {
    // A platform subscription may already be gone during native teardown.
  }
};

const nextBoundaryDelayFor = (now: () => string, expiryAt: string | null): number | null => {
  if (expiryAt === null) return null;
  try {
    const current = now();
    const currentMilliseconds = Date.parse(current);
    const expiryMilliseconds = Date.parse(expiryAt);
    if (!Number.isFinite(currentMilliseconds) || !Number.isFinite(expiryMilliseconds)) {
      return null;
    }
    const delay = expiryMilliseconds - currentMilliseconds;
    return delay > 0 ? delay : 1;
  } catch {
    return null;
  }
};

/**
 * Composes the two read/write projections over one already-open SQLite store.
 * Construction is side-effect free; `activate` owns all subscriptions and the
 * timer so React can create this object during render without touching I/O.
 */
export const createNativeJourneyPersistence = (
  options: NativeJourneyPersistenceOptions = {},
): NativeJourneyPersistence => {
  const sqlite = options.sqlite ?? undefined;
  const scope = options.scope ?? null;
  const now = options.now ?? nativeNow;
  const scheduler = options.scheduler ?? nativeScheduler;
  const historyService = createJourneyHistoryService(sqlite === undefined ? {} : { sqlite });
  const preferences: JourneyPreferencesService | undefined =
    sqlite === undefined
      ? undefined
      : options.ownerClient === undefined
        ? createJourneyPreferencesService(sqlite)
        : createOwnerPrefsProjection({
            api: options.ownerClient,
            sqlite,
            requestIdFactory: options.requestIdFactory ?? (() => createRuntimeId('request')),
            now,
          });
  const listeners = new Set<() => void>();
  let snapshot = snapshotFor(scope, sqlite === undefined ? unavailableHistory() : null);
  let active = false;
  let activationGeneration = 0;
  let disposed = false;
  let timer: unknown = null;
  let unsubscribeController: (() => void) | undefined;
  let unsubscribeForeground: (() => void) | undefined;

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // One stale render subscriber must not block the remaining listeners.
      }
    }
  };

  const refresh = (): void => {
    if (disposed || sqlite === undefined) return;
    let result: JourneyHistoryResult;
    try {
      result = historyService.list();
    } catch {
      result = unavailableHistory();
    }
    const next = snapshotFor(scope, result);
    if (!snapshotEqual(snapshot, next)) {
      snapshot = next;
      emit();
    }
    if (active) scheduleBoundaryTimer(activationGeneration);
  };

  const cancelBoundaryTimer = (): void => {
    if (timer === null) return;
    try {
      scheduler.cancel(timer);
    } catch {
      // Timer cancellation is best effort during unmount.
    }
    timer = null;
  };

  const scheduleBoundaryTimer = (generation: number): void => {
    if (!active || disposed || sqlite === undefined || activationGeneration !== generation) {
      return;
    }
    cancelBoundaryTimer();
    const delay = nextBoundaryDelayFor(now, snapshot.nextExpiryAt);
    if (delay === null) return;
    try {
      const handle = scheduler.schedule(() => {
        if (timer !== handle || !active || disposed || activationGeneration !== generation) {
          return;
        }
        timer = null;
        refresh();
      }, delay);
      timer = handle;
    } catch {
      timer = null;
    }
  };

  const deactivate = (generation?: number): void => {
    if (!active || (generation !== undefined && activationGeneration !== generation)) return;
    active = false;
    activationGeneration += 1;
    safeUnsubscribe(unsubscribeController);
    safeUnsubscribe(unsubscribeForeground);
    unsubscribeController = undefined;
    unsubscribeForeground = undefined;
    cancelBoundaryTimer();
  };

  const activate = (): (() => void) => {
    if (disposed || active) return noop;
    const generation = activationGeneration + 1;
    activationGeneration = generation;
    active = true;
    const refreshForGeneration = (): void => {
      if (active && activationGeneration === generation) refresh();
    };
    refresh();
    if (preferences?.hydrate !== undefined) {
      void preferences.hydrate().catch(() => undefined);
    }
    if (sqlite !== undefined && options.controller !== undefined) {
      try {
        unsubscribeController = options.controller.subscribe(refreshForGeneration);
      } catch {
        unsubscribeController = undefined;
      }
    }
    if (sqlite !== undefined && options.subscribeForeground !== undefined) {
      try {
        unsubscribeForeground = subscribeToAssistantResponseResume(
          options.subscribeForeground,
          refreshForGeneration,
        );
      } catch {
        unsubscribeForeground = undefined;
      }
    }
    return () => deactivate(generation);
  };

  const dispose = (): void => {
    if (disposed) return;
    deactivate();
    disposed = true;
    listeners.clear();
  };

  return {
    preferences,
    historyService,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (disposed) return noop;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activate,
    refresh,
    dispose,
  };
};
