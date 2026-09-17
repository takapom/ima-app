import { PhotoProviderError } from '@worker/runtime/ports/photo-media';
import { HotPepperError } from '@worker/adapters/outbound/providers/hot-pepper/types';
import type {
  RuntimeProviderTransportCompletion,
  RuntimeProviderTransportObserver,
} from '@worker/runtime/tracing/runtime-provider-trace-contract';
import {
  emitRuntimeProviderTrace,
  type RuntimeProviderTrace,
  type RuntimeProviderTraceOptions,
  type RuntimeProviderTraceProvider,
} from '@worker/runtime/tracing/runtime-provider-trace';
type ProviderError = PhotoProviderError | HotPepperError;

type CallState = {
  readonly callId: string;
  readonly startedAt: number | undefined;
  readonly options: RuntimeProviderTraceOptions;
  readonly provider: RuntimeProviderTraceProvider;
  readonly apiElementCount: number | undefined;
  settled: boolean;
};

const safeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000
    ? value
    : undefined;

const durationFor = (
  startedAt: number | undefined,
  monotonicNow: () => number,
): number | undefined => {
  if (startedAt === undefined) return undefined;
  try {
    const elapsed = monotonicNow() - startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 600_000) return undefined;
    return Math.round(elapsed);
  } catch {
    return undefined;
  }
};

const isProviderError = (error: unknown): error is ProviderError =>
  error instanceof PhotoProviderError || error instanceof HotPepperError;

const outcomeForError = (
  error: unknown,
  signal: AbortSignal | undefined,
): Pick<RuntimeProviderTrace, 'status' | 'resultCode'> => {
  if (isProviderError(error)) {
    switch (error.code) {
      case 'CANCELLED':
        return { status: 'cancelled', resultCode: 'CANCELLED' };
      case 'TIMEOUT':
        return { status: 'error', resultCode: 'PROVIDER_TIMEOUT' };
      case 'RATE_LIMITED':
        return { status: 'error', resultCode: 'RATE_LIMITED' };
      case 'INVALID_REQUEST':
        return { status: 'error', resultCode: 'INVALID_ARGUMENT' };
      case 'NOT_FOUND':
        return { status: 'error', resultCode: 'NOT_FOUND' };
      case 'MISSING_API_KEY':
      case 'UPSTREAM_UNAVAILABLE':
        return { status: 'error', resultCode: 'PROVIDER_UNAVAILABLE' };
      case 'SCHEMA_MISMATCH':
        return { status: 'error', resultCode: 'INTERNAL' };
      case 'EXPIRED':
        return { status: 'error', resultCode: 'EXPIRED' };
      case 'NO_MATCH':
        return { status: 'error', resultCode: 'NOT_FOUND' };
      case 'AMBIGUOUS_MATCH':
      case 'SOURCE_CONFLICT':
        return { status: 'error', resultCode: 'CONFLICT' };
      case 'MISSING_ATTRIBUTION':
      case 'UNSUPPORTED':
        return { status: 'error', resultCode: 'PROVIDER_UNAVAILABLE' };
      case 'POLICY_DENIED':
        return { status: 'error', resultCode: 'FORBIDDEN' };
      case 'UNSUPPORTED_MEDIA_TYPE':
      case 'RESULT_TOO_LARGE':
      case 'REDIRECT_REJECTED':
        return { status: 'error', resultCode: 'PROVIDER_UNAVAILABLE' };
    }
  }
  return signal?.aborted === true
    ? { status: 'cancelled', resultCode: 'CANCELLED' }
    : { status: 'error', resultCode: 'INTERNAL' };
};

const callStateFor = (
  options: RuntimeProviderTraceOptions,
  provider: RuntimeProviderTraceProvider,
  apiElementCount: number | undefined,
): CallState => ({
  callId: crypto.randomUUID(),
  startedAt: (() => {
    try {
      const value = options.monotonicNow();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  })(),
  options,
  provider,
  apiElementCount,
  settled: false,
});

const emitCompleted = (
  state: CallState,
  outcome: Pick<RuntimeProviderTrace, 'status' | 'resultCode'>,
): void => {
  if (state.settled) return;
  state.settled = true;
  let occurredAt: string;
  try {
    occurredAt = state.options.clock();
  } catch {
    return;
  }
  const durationMs = durationFor(state.startedAt, state.options.monotonicNow);
  emitRuntimeProviderTrace(state.options.sink, {
    ownerScopeRef: state.options.ownerScopeRef,
    threadId: state.options.threadId,
    turnId: state.options.turnId,
    revision: state.options.revision,
    callId: state.callId,
    provider: state.provider,
    occurredAt,
    ...outcome,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(state.apiElementCount === undefined ? {} : { apiElementCount: state.apiElementCount }),
  });
};

const elementCountFor = (value: unknown): number | undefined => safeInteger(value);

/** Creates the observer used by transports at the exact moment their fetcher starts. */
export const createRuntimeProviderTransportObserver = (
  options: RuntimeProviderTraceOptions,
): RuntimeProviderTransportObserver => ({
  begin: ({ provider, apiElementCount }) => {
    let state: CallState | undefined;
    try {
      state = callStateFor(options, provider, elementCountFor(apiElementCount));
    } catch {
      return { complete: () => undefined };
    }
    return {
      complete: (completion: RuntimeProviderTransportCompletion): void => {
        if (state === undefined) return;
        emitCompleted(
          state,
          completion.status === 'ok'
            ? { status: 'ok', resultCode: 'OK' }
            : outcomeForError(completion.error, completion.signal),
        );
      },
    };
  },
});
