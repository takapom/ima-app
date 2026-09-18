import { wrapLanguageModel } from 'ai';
import type {
  RuntimeModelGuardGenerateResult,
  RuntimeModelGuardModel,
  RuntimeModelGuardStreamPart,
} from '@worker/infrastructure/runtime/turn-execution/runtime-model-guard';
import type {
  TelemetryResultCode,
  TelemetryStatus,
  TraceRecord,
} from '@worker/infrastructure/telemetry/schema';
import { parseTraceRecord } from '@worker/infrastructure/telemetry/trace';
import {
  createBestEffortRuntimeTraceSink,
  type RuntimeTraceSinkFailure,
} from '@worker/infrastructure/runtime/tracing/runtime-trace-sink';

export type RuntimeModelTrace = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly callId: string;
  readonly provider?: 'openai';
  readonly occurredAt: string;
  readonly status: TelemetryStatus;
  readonly resultCode: TelemetryResultCode;
  readonly durationMs?: number;
  readonly tokenCount?: number;
};

export type RuntimeModelTraceSink = (trace: RuntimeModelTrace) => void | Promise<void>;
export type RuntimeModelTraceFailure = RuntimeTraceSinkFailure;

export type RuntimeModelTraceOptions = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: number;
  /** Live calls are identified as OpenAI; fixture calls remain namespace-separated and unlabelled. */
  readonly provider?: 'openai';
  readonly clock: () => string;
  readonly monotonicNow: () => number;
  readonly sink: RuntimeModelTraceSink;
};

type CallState = {
  readonly callId: string;
  readonly startedAt: number | undefined;
  readonly options: RuntimeModelTraceOptions;
  settled: boolean;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const safeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** V3 exposes input/output totals separately; only a complete, bounded pair is measured. */
export const tokenCountForModelUsage = (usage: unknown): number | undefined => {
  if (!record(usage)) return undefined;
  const input = record(usage.inputTokens) ? safeInteger(usage.inputTokens.total) : undefined;
  const output = record(usage.outputTokens) ? safeInteger(usage.outputTokens.total) : undefined;
  if (input === undefined || output === undefined) return undefined;
  const total = input + output;
  return total <= 10_000_000 ? total : undefined;
};

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

export const traceIdForRuntimeModel = (trace: RuntimeModelTrace): Promise<string> => {
  const identity = [
    'model-call',
    trace.ownerScopeRef,
    trace.threadId,
    trace.turnId,
    String(trace.revision),
    trace.callId,
  ].join('\u0000');
  return sha256Hex(identity).then((digest) => `call-${digest}`);
};

export const traceRecordForRuntimeModel = async (
  trace: RuntimeModelTrace,
): Promise<TraceRecord | undefined> => {
  const parsed = parseTraceRecord({
    schemaVersion: 'v1',
    traceId: await traceIdForRuntimeModel(trace),
    threadId: trace.threadId,
    turnId: trace.turnId,
    revision: trace.revision,
    occurredAt: trace.occurredAt,
    operation: 'call',
    ...(trace.provider === undefined ? {} : { provider: trace.provider }),
    status: trace.status,
    resultCode: trace.resultCode,
    ...(trace.durationMs === undefined ? {} : { durationMs: trace.durationMs }),
    ...(trace.tokenCount === undefined ? {} : { tokenCount: trace.tokenCount }),
  });
  return parsed;
};

export const emitRuntimeModelTrace = (
  sink: RuntimeModelTraceSink | undefined,
  trace: RuntimeModelTrace,
): void => {
  if (sink === undefined) return;
  try {
    void Promise.resolve(sink(trace)).catch(() => undefined);
  } catch {
    // Runtime telemetry is best effort and never changes the model result.
  }
};

export const createBestEffortRuntimeModelTraceSink = (
  store: Parameters<typeof createBestEffortRuntimeTraceSink>[0],
  schedule?: (promise: Promise<void>) => void,
  onFailure?: (failure: RuntimeModelTraceFailure) => void,
): RuntimeModelTraceSink => {
  return createBestEffortRuntimeTraceSink(store, traceRecordForRuntimeModel, schedule, onFailure);
};

const callErrorOutcome = (
  signal: AbortSignal | undefined,
  consumerCancelled = false,
): {
  readonly status: TelemetryStatus;
  readonly resultCode: TelemetryResultCode;
} =>
  consumerCancelled || signal?.aborted === true
    ? { status: 'cancelled', resultCode: 'CANCELLED' }
    : { status: 'error', resultCode: 'INTERNAL' };

const callStateFor = (options: RuntimeModelTraceOptions): CallState => ({
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
  settled: false,
});

const emitCompleted = (
  state: CallState,
  outcome: Pick<RuntimeModelTrace, 'status' | 'resultCode'>,
  tokenCount?: number,
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
  emitRuntimeModelTrace(state.options.sink, {
    ownerScopeRef: state.options.ownerScopeRef,
    threadId: state.options.threadId,
    turnId: state.options.turnId,
    revision: state.options.revision,
    callId: state.callId,
    occurredAt,
    ...(state.options.provider === undefined ? {} : { provider: state.options.provider }),
    ...outcome,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(tokenCount === undefined ? {} : { tokenCount }),
  });
};

const streamWithTrace = (
  stream: ReadableStream<RuntimeModelGuardStreamPart>,
  state: CallState,
  signal: AbortSignal | undefined,
): ReadableStream<RuntimeModelGuardStreamPart> => {
  const reader = stream.getReader();
  let sawFinish = false;
  const onAbort = (): void => {
    emitCompleted(state, callErrorOutcome(signal));
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  const releaseReader = (): void => {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A pending read keeps the lock until the provider settles; its next path releases it.
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted === true) onAbort();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          emitCompleted(
            state,
            sawFinish ? { status: 'ok', resultCode: 'OK' } : callErrorOutcome(signal),
          );
          releaseReader();
          controller.close();
          return;
        }
        if (next.value.type === 'finish') {
          sawFinish = true;
          emitCompleted(
            state,
            {
              status: next.value.finishReason.unified === 'error' ? 'error' : 'ok',
              resultCode: next.value.finishReason.unified === 'error' ? 'INTERNAL' : 'OK',
            },
            tokenCountForModelUsage(next.value.usage),
          );
        } else if (next.value.type === 'error') {
          emitCompleted(state, callErrorOutcome(signal));
        }
        controller.enqueue(next.value);
      } catch (error: unknown) {
        emitCompleted(state, callErrorOutcome(signal));
        releaseReader();
        controller.error(error);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
      releaseReader();
      emitCompleted(state, callErrorOutcome(signal, true));
    },
  });
};

/** Wraps the actual V3 model; the Think loop and runtime guard remain the loop/admission owners. */
export const wrapRuntimeModelTrace = (
  model: RuntimeModelGuardModel,
  options: RuntimeModelTraceOptions,
): RuntimeModelGuardModel =>
  wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v3',
      wrapGenerate: async ({ doGenerate, params }) => {
        const state = callStateFor(options);
        try {
          const result: RuntimeModelGuardGenerateResult = await doGenerate();
          emitCompleted(
            state,
            {
              status: result.finishReason.unified === 'error' ? 'error' : 'ok',
              resultCode: result.finishReason.unified === 'error' ? 'INTERNAL' : 'OK',
            },
            tokenCountForModelUsage(result.usage),
          );
          return result;
        } catch (error: unknown) {
          emitCompleted(state, callErrorOutcome(params.abortSignal));
          throw error;
        }
      },
      wrapStream: async ({ doStream, params }) => {
        const state = callStateFor(options);
        try {
          const result = await doStream();
          return { ...result, stream: streamWithTrace(result.stream, state, params.abortSignal) };
        } catch (error: unknown) {
          emitCompleted(state, callErrorOutcome(params.abortSignal));
          throw error;
        }
      },
    },
  });
