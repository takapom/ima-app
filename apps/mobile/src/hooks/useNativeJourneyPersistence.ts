import { AppState } from 'react-native';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ResponseResumeSubscription } from '../services/assistant-response-clock';
import type { NativeMobileJourneyRuntime } from '../services/runtime/native-mobile-runtime';
import {
  createNativeJourneyPersistence,
  type NativeJourneyPersistenceScheduler,
  type NativeJourneyPersistenceSnapshot,
} from '../services/native-journey-persistence';

export type UseNativeJourneyPersistenceOptions = {
  readonly runtime?: NativeMobileJourneyRuntime | null;
  /** Optional host clock keeps the SQLite expiry timer on the runtime timeline. */
  readonly now?: () => string;
  /** Tests and alternate hosts may provide their own foreground source. */
  readonly subscribeForeground?: ResponseResumeSubscription;
  /** Tests may provide a deterministic boundary scheduler. */
  readonly scheduler?: NativeJourneyPersistenceScheduler;
};

export type NativeJourneyPersistenceHookResult = NativeJourneyPersistenceSnapshot & {
  readonly preferences: ReturnType<typeof createNativeJourneyPersistence>['preferences'];
  readonly refresh: () => void;
};

const subscribeNativeForeground: ResponseResumeSubscription = (listener) => {
  const subscription = AppState.addEventListener('change', (status) => listener(status));
  return () => subscription.remove();
};

/**
 * Exposes one runtime's owner-scoped preferences and history projections. The
 * runtime owns the SQLite handle; this hook only owns subscriptions and view
 * state, and drops a previous scope's items before publishing the next one.
 */
export const useNativeJourneyPersistence = (
  options: UseNativeJourneyPersistenceOptions = {},
): NativeJourneyPersistenceHookResult => {
  const runtime = options.runtime ?? null;
  const sqlite = runtime?.sqlite ?? undefined;
  const controller = runtime?.binding?.controller;
  const scope = runtime?.storageScope ?? null;
  const subscribeForeground = options.subscribeForeground ?? subscribeNativeForeground;
  const ownerClient = runtime?.ownerClient;
  const requestIdFactory = runtime?.requestIdFactory;
  const persistence = useMemo(
    () =>
      createNativeJourneyPersistence({
        ...(sqlite === undefined ? {} : { sqlite }),
        ...(controller === undefined ? {} : { controller }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(subscribeForeground === undefined ? {} : { subscribeForeground }),
        ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
        ...(ownerClient === undefined ? {} : { ownerClient }),
        ...(requestIdFactory === undefined ? {} : { requestIdFactory }),
        scope,
      }),
    [
      controller,
      options.now,
      options.scheduler,
      ownerClient,
      requestIdFactory,
      scope,
      sqlite,
      subscribeForeground,
    ],
  );
  const snapshot = useSyncExternalStore(
    persistence.subscribe,
    persistence.getSnapshot,
    persistence.getSnapshot,
  );
  useEffect(() => {
    return persistence.activate();
  }, [persistence]);
  return {
    ...snapshot,
    preferences: persistence.preferences,
    refresh: persistence.refresh,
  };
};
