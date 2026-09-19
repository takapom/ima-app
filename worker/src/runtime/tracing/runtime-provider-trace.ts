import type { TelemetryResultCode, TelemetryStatus, TraceRecord } from '@worker/telemetry/schema';
import { parseTraceRecord, type TelemetryTraceStore } from '@worker/telemetry/trace';
import {
  createBestEffortRuntimeTraceSink,
  type RuntimeTraceSinkFailure,
} from '@worker/runtime/tracing/runtime-trace-sink';
import type { RuntimeProviderTransportProvider } from '@worker/runtime/tracing/runtime-provider-trace-contract';

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
