import { GooglePlaceDetailsError } from '../places-details/types';
import { GoogleTextSearchError } from '../places-search/types';
import { GoogleRouteMatrixError } from '../routes/types';
import type { TelemetryResultCode, TelemetryStatus, TraceRecord } from '../../telemetry/schema';
import { parseTraceRecord, type TelemetryTraceStore } from '../../telemetry/trace';
import {
  createBestEffortRuntimeTraceSink,
  type RuntimeTraceSinkFailure,
} from '../../runtime/runtime-trace-sink';
import type {
  RuntimeProviderTransportCompletion,
  RuntimeProviderTransportObserver,
  RuntimeProviderTransportProvider,
} from './runtime-provider-trace-contract';

export type RuntimeProviderTraceProvider = RuntimeProviderTransportProvider;

export type RuntimeProviderTrace = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly callId: string;
  readonly provider: RuntimeProviderTraceProvider;
  readonly occurredAt: string;
  readonly status: TelemetryStatus;
  readonly resultCode: TelemetryResultCode;
  readonly durationMs?: number;
  /** A validated provider-request count; this is not a cost or billing estimate. */
  readonly apiElementCount?: number;
};

export type RuntimeProviderTraceSink = (trace: RuntimeProviderTrace) => void | Promise<void>;
export type RuntimeProviderTraceFailure = RuntimeTraceSinkFailure;

export type RuntimeProviderTraceOptions = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly clock: () => string;
  readonly monotonicNow: () => number;
  readonly sink: RuntimeProviderTraceSink;
};

type ProviderError = GoogleTextSearchError | GooglePlaceDetailsError | GoogleRouteMatrixError;

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

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const traceIdForRuntimeProvider = (
  trace: Pick<
    RuntimeProviderTrace,
    'ownerScopeRef' | 'threadId' | 'turnId' | 'revision' | 'callId' | 'provider'
  >,
): Promise<string> => {
  const identity = [
    'provider-call',
    trace.provider,
    trace.ownerScopeRef,
    trace.threadId,
    trace.turnId,
    String(trace.revision),
    trace.callId,
  ].join('\u0000');
  return sha256Hex(identity).then((digest) => `provider-${digest}`);
};

export const traceRecordForRuntimeProvider = async (
  trace: RuntimeProviderTrace,
): Promise<TraceRecord | undefined> =>
  parseTraceRecord({
    schemaVersion: 'v1',
    traceId: await traceIdForRuntimeProvider(trace),
    threadId: trace.threadId,
    turnId: trace.turnId,
    revision: trace.revision,
    occurredAt: trace.occurredAt,
    operation: 'provider',
    provider: trace.provider,
    status: trace.status,
    resultCode: trace.resultCode,
    ...(trace.durationMs === undefined ? {} : { durationMs: trace.durationMs }),
    ...(trace.apiElementCount === undefined ? {} : { apiElementCount: trace.apiElementCount }),
  });

export const emitRuntimeProviderTrace = (
  sink: RuntimeProviderTraceSink | undefined,
  trace: RuntimeProviderTrace,
): void => {
  if (sink === undefined) return;
  try {
    void Promise.resolve(sink(trace)).catch(() => undefined);
  } catch {
    // Provider telemetry is best effort and must never change the provider result.
  }
};

export const createBestEffortRuntimeProviderTraceSink = (
  store: Pick<TelemetryTraceStore, 'write'>,
  schedule?: (promise: Promise<void>) => void,
  onFailure?: (failure: RuntimeProviderTraceFailure) => void,
): RuntimeProviderTraceSink =>
  createBestEffortRuntimeTraceSink(store, traceRecordForRuntimeProvider, schedule, onFailure);

const isProviderError = (error: unknown): error is ProviderError =>
  error instanceof GoogleTextSearchError ||
  error instanceof GooglePlaceDetailsError ||
  error instanceof GoogleRouteMatrixError;

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
