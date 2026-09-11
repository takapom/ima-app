import { useEffect, useRef, useState } from 'react';
import type { JourneyApiControllerBinding } from '../services/api/journey-api-binding';
import {
  createNativeMobileJourneyRuntime,
  type NativeMobileJourneyRuntime,
  type NativeMobileRuntimeOptions,
  type NativeMobileRuntimeReason,
} from '../services/api/native-mobile-runtime';

export type UseNativeMobileRuntimeOptions = {
  /** A host-composed binding bypasses every native SDK load. */
  readonly journeyApi?: JourneyApiControllerBinding;
  readonly mobileRuntimeOptions?: NativeMobileRuntimeOptions;
};

export type NativeMobileRuntimeHookResult = {
  readonly status: 'loading' | 'ready' | 'error';
  readonly runtime: NativeMobileJourneyRuntime | null;
  readonly binding: JourneyApiControllerBinding | null;
  readonly reason: NativeMobileRuntimeReason | null;
};

type HookState = {
  readonly options: NativeMobileRuntimeOptions | undefined;
  readonly override: JourneyApiControllerBinding | undefined;
  readonly status: 'loading' | 'ready' | 'error';
  readonly runtime: NativeMobileJourneyRuntime | null;
  readonly reason: NativeMobileRuntimeReason | null;
};

const loadingState = (
  options: NativeMobileRuntimeOptions | undefined,
  override: JourneyApiControllerBinding | undefined,
): HookState => ({
  options,
  override,
  status: 'loading',
  runtime: null,
  reason: null,
});

const readyOverrideState = (
  options: NativeMobileRuntimeOptions | undefined,
  override: JourneyApiControllerBinding,
): HookState => ({
  options,
  override,
  status: 'ready',
  runtime: null,
  reason: null,
});

type OwnedRuntime = {
  readonly generation: number;
  readonly runtime: NativeMobileJourneyRuntime;
};

const disposeSafely = (runtime: NativeMobileJourneyRuntime): void => {
  try {
    runtime.dispose();
  } catch {
    // Native teardown must not surface as a React effect or promise error.
  }
};

/**
 * Owns the asynchronous native composition. A stale completion is disposed
 * immediately, which keeps a late SQLite handle from becoming reachable.
 */
export const useNativeMobileRuntime = (
  input: UseNativeMobileRuntimeOptions = {},
): NativeMobileRuntimeHookResult => {
  const { journeyApi, mobileRuntimeOptions } = input;
  const [state, setState] = useState<HookState>(() =>
    journeyApi === undefined
      ? loadingState(mobileRuntimeOptions, undefined)
      : readyOverrideState(mobileRuntimeOptions, journeyApi),
  );
  const generation = useRef(0);
  const owned = useRef<OwnedRuntime | null>(null);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const abort = new AbortController();
    owned.current = null;
    if (journeyApi !== undefined) {
      setState(readyOverrideState(mobileRuntimeOptions, journeyApi));
      return () => abort.abort();
    }

    setState(loadingState(mobileRuntimeOptions, undefined));
    void createNativeMobileJourneyRuntime(mobileRuntimeOptions ?? {}, { signal: abort.signal })
      .then((runtime) => {
        if (abort.signal.aborted || generation.current !== currentGeneration) {
          disposeSafely(runtime);
          return;
        }
        if (runtime.binding === null || runtime.reason !== null) {
          setState({
            options: mobileRuntimeOptions,
            override: undefined,
            status: 'error',
            runtime: null,
            reason: runtime.reason,
          });
          disposeSafely(runtime);
          return;
        }
        owned.current = { generation: currentGeneration, runtime };
        setState({
          options: mobileRuntimeOptions,
          override: undefined,
          status: 'ready',
          runtime,
          reason: null,
        });
      })
      .catch(() => {
        if (abort.signal.aborted || generation.current !== currentGeneration) return;
        setState({
          options: mobileRuntimeOptions,
          override: undefined,
          status: 'error',
          runtime: null,
          reason: 'native_runtime_failed',
        });
      });

    return () => {
      abort.abort();
      const current = owned.current;
      if (current?.generation === currentGeneration) {
        owned.current = null;
        disposeSafely(current.runtime);
      }
    };
  }, [journeyApi, mobileRuntimeOptions]);

  const currentState =
    journeyApi !== undefined
      ? readyOverrideState(mobileRuntimeOptions, journeyApi)
      : state.options === mobileRuntimeOptions && state.override === undefined
        ? state
        : loadingState(mobileRuntimeOptions, undefined);
  return {
    status: currentState.status,
    runtime: currentState.runtime,
    binding: journeyApi ?? currentState.runtime?.binding ?? null,
    reason: currentState.reason,
  };
};
