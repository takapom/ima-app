import { AppState } from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AssistantResponseState } from '../state/assistant-response';
import {
  nextAssistantResponseExpiryAt,
  projectAssistantResponseState,
  type AssistantResponseProjectionNow,
} from '../state/assistant-response-projection';
import {
  advanceAssistantResponseNow,
  createMonotonicAssistantResponseClock,
  subscribeToAssistantResponseResume,
  systemAssistantResponseClock,
  type AssistantResponseClock,
} from '../services/assistant-response-clock';

/**
 * Refreshes the render projection at the next retention boundary while retaining raw state.
 * Tests and hosts can pass `now`; the default clock lives at the service boundary.
 */
export const useAssistantResponseProjection = (
  state: AssistantResponseState,
  now?: AssistantResponseProjectionNow,
  clock: AssistantResponseClock = systemAssistantResponseClock,
): AssistantResponseState => {
  const monotonicClock = useMemo(() => createMonotonicAssistantResponseClock(clock), [clock]);
  const [projectionNow, setProjectionNow] = useState<AssistantResponseProjectionNow>(() =>
    now === undefined ? monotonicClock() : now,
  );
  const observeNow = useCallback((candidate: AssistantResponseProjectionNow): void => {
    setProjectionNow((current) => advanceAssistantResponseNow(current, candidate));
  }, []);

  const renderNow =
    now === undefined
      ? advanceAssistantResponseNow(projectionNow, monotonicClock())
      : projectionNow;

  useEffect(() => {
    if (now !== undefined) {
      return undefined;
    }

    const unsubscribeResume = subscribeToAssistantResponseResume(
      (listener) => {
        const subscription = AppState.addEventListener('change', listener);
        return () => subscription.remove();
      },
      () => observeNow(monotonicClock()),
    );
    return unsubscribeResume;
  }, [monotonicClock, now, observeNow]);

  useEffect(() => {
    observeNow(now ?? monotonicClock());
  }, [monotonicClock, now, observeNow, state]);

  useEffect(() => {
    if (now !== undefined) return undefined;

    const expiryAt = nextAssistantResponseExpiryAt(state, renderNow);
    const delay =
      expiryAt === null ? null : Math.max(1, Date.parse(expiryAt) - Date.parse(renderNow) + 1);
    const timer = delay === null ? null : setTimeout(() => observeNow(monotonicClock()), delay);
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [monotonicClock, now, observeNow, renderNow, state]);
  return useMemo(() => projectAssistantResponseState(state, renderNow), [renderNow, state]);
};
