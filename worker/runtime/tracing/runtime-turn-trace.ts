import type { TelemetryResultCode, TelemetryStatus, TraceRecord } from '@worker/telemetry/schema';
import { parseTraceRecord, type TelemetryTraceStore } from '@worker/telemetry/trace';
import {
  createBestEffortRuntimeTraceSink,
  type RuntimeTraceSinkFailure,
} from '@worker/runtime/tracing/runtime-trace-sink';

export type RuntimeTurnTrace = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly occurredAt: string;
  readonly status: TelemetryStatus;
  readonly resultCode: TelemetryResultCode;
  readonly durationMs?: number;
};

export type RuntimeTurnTraceSink = (trace: RuntimeTurnTrace) => void | Promise<void>;

export type RuntimeTurnTraceFailure = RuntimeTraceSinkFailure;

export type RuntimeTraceMode = 'fixture' | 'live' | 'unknown';

export const runtimeTraceModeFor = (value: unknown): RuntimeTraceMode =>
  value === 'fixture' || value === 'live' ? value : 'unknown';

export const telemetryObjectNameForRuntimeTraceMode = (mode: RuntimeTraceMode): string =>
  `telemetry-${mode}`;

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const traceIdForRuntimeTurn = (
  trace: Pick<RuntimeTurnTrace, 'threadId' | 'turnId' | 'revision'>,
): Promise<string> => {
  const identity = `turn\u0000${trace.threadId}\u0000${trace.turnId}\u0000${trace.revision}`;
  return sha256Hex(identity).then((digest) => `turn-${digest}`);
};

export const traceRecordForRuntimeTurn = async (
  trace: RuntimeTurnTrace,
): Promise<TraceRecord | undefined> => {
  const parsed = parseTraceRecord({
    schemaVersion: 'v1',
    traceId: await traceIdForRuntimeTurn(trace),
    threadId: trace.threadId,
    turnId: trace.turnId,
    revision: trace.revision,
    occurredAt: trace.occurredAt,
    operation: 'turn',
    status: trace.status,
    resultCode: trace.resultCode,
    ...(trace.durationMs === undefined ? {} : { durationMs: trace.durationMs }),
  });
  return parsed;
};

export const emitRuntimeTurnTrace = (
  sink: RuntimeTurnTraceSink | undefined,
  trace: RuntimeTurnTrace,
): void => {
  if (sink === undefined) return;
  try {
    void Promise.resolve(sink(trace)).catch(() => undefined);
  } catch {
    // Telemetry is best effort and must never change the turn result.
  }
};

export const createBestEffortRuntimeTurnTraceSink = (
  store: Pick<TelemetryTraceStore, 'write'>,
  schedule?: (promise: Promise<void>) => void,
  onFailure?: (failure: RuntimeTurnTraceFailure) => void,
): RuntimeTurnTraceSink => {
  return createBestEffortRuntimeTraceSink(store, traceRecordForRuntimeTurn, schedule, onFailure);
};

export const runtimeTurnTraceOutcome = (input: {
  readonly savedStatus: string | undefined;
  readonly guardFailureCode: string | undefined;
  readonly failureCode: string | undefined;
  readonly responseAvailable: boolean;
  readonly cancelled: boolean;
}): Pick<RuntimeTurnTrace, 'status' | 'resultCode'> => {
  const code = input.guardFailureCode ?? input.failureCode;
  if (input.cancelled || code === 'CANCELLED' || code === 'MODEL_STREAM_ABORTED') {
    return { status: 'cancelled', resultCode: 'CANCELLED' };
  }
  if (input.savedStatus === 'completed' && input.responseAvailable === true) {
    return { status: 'ok', resultCode: 'OK' };
  }
  if (code === 'BUDGET_EXCEEDED') {
    return { status: 'error', resultCode: 'BUDGET_EXCEEDED' };
  }
  if (code === 'STALE_TURN' || code === 'DEADLINE') {
    return { status: 'error', resultCode: 'EXPIRED' };
  }
  if (code === 'FORBIDDEN' || code === 'UNKNOWN_TOOL' || code === 'INVALID_ARGUMENT') {
    return { status: 'error', resultCode: code === 'FORBIDDEN' ? 'FORBIDDEN' : 'INVALID_ARGUMENT' };
  }
  return { status: 'error', resultCode: 'INTERNAL' };
};
