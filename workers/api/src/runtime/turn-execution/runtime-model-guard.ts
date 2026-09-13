import { wrapLanguageModel, type LanguageModel } from 'ai';
import {
  RUNTIME_PUBLIC_OPERATIONS,
  validateRuntimeBatch,
  type RuntimeBatchAction,
  type RuntimeBatchIssueCode,
  type RuntimeBatchResult,
} from './runtime-batch';
import type { RuntimeBudget, RuntimeBudgetDenial, RuntimeBudgetResult } from '../runtime-budget';

/** AI SDK's public model middleware currently accepts V3 models. */
export type RuntimeModelGuardModel = Extract<LanguageModel, { specificationVersion: 'v3' }>;
export type RuntimeModelGuardCallOptions = Parameters<RuntimeModelGuardModel['doStream']>[0];
export type RuntimeModelGuardStreamResult = Awaited<ReturnType<RuntimeModelGuardModel['doStream']>>;
export type RuntimeModelGuardStreamPart =
  RuntimeModelGuardStreamResult['stream'] extends ReadableStream<infer Part> ? Part : never;
export type RuntimeModelGuardGenerateResult = Awaited<
  ReturnType<RuntimeModelGuardModel['doGenerate']>
>;

/** AI SDK retries are configured by the factory, because V3 model calls have no retry option. */
export const RUNTIME_MODEL_MAX_RETRIES = 0 as const;

export type RuntimeModelGuardErrorCode =
  | RuntimeBudgetDenial['code']
  | RuntimeBatchIssueCode
  | 'MODEL_STREAM_TIMEOUT'
  | 'MODEL_STREAM_LIMIT'
  | 'MODEL_STREAM_ABORTED'
  | 'UNSUPPORTED_PART'
  | 'FINISH_COUNT';

const guardErrors = new WeakSet<object>();

export class RuntimeModelGuardError extends Error {
  readonly code: RuntimeModelGuardErrorCode;

  constructor(code: RuntimeModelGuardErrorCode, message = `runtime model step denied: ${code}`) {
    super(message);
    this.name = 'RuntimeModelGuardError';
    this.code = code;
    guardErrors.add(this);
  }
}

export const isRuntimeModelGuardError = (value: unknown): value is RuntimeModelGuardError =>
  typeof value === 'object' && value !== null && guardErrors.has(value);

export type RuntimeModelGuardAcceptance = {
  readonly terminal: 'none' | 'message' | 'submit';
  /** Batch-validated final text; Core message and evidence validation are still required. */
  readonly finalText: string | null;
  readonly emptyFinal: boolean;
  readonly partCount: number;
  readonly bytes: number;
};

export type RuntimeModelGuardOptions = {
  readonly budget: Pick<RuntimeBudget, 'reserveModelStep' | 'checkAdmission'>;
  /** Runtime factory decides whether this call is the final-response call. */
  readonly isFinalResponse?: (params: RuntimeModelGuardCallOptions) => boolean;
  /** Remaining wall-clock allowance supplied by the same clock as the RuntimeBudget. */
  readonly remainingTimeMs: (finalResponse: boolean) => number;
  readonly maxBufferMs?: number;
  readonly maxParts?: number;
  readonly maxBytes?: number;
  /** Runs only after complete output and batch policy have been accepted. */
  readonly onAccepted?: (acceptance: RuntimeModelGuardAcceptance) => void;
  /** Keeps a known denial attached to the current wrapped model invocation. */
  readonly onFailure?: (error: RuntimeModelGuardError) => void;
};

const DEFAULT_MAX_BUFFER_MS = 10_000;
const DEFAULT_MAX_PARTS = 4096;
const DEFAULT_MAX_BYTES = 64 * 1024;
const STREAM_PART_TYPES = new Set([
  'stream-start',
  'response-metadata',
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-end',
  'tool-call',
  'finish',
]);

const positiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const optionValue = (value: number | undefined, fallback: number, name: string): number => {
  const selected = value ?? fallback;
  if (!positiveInteger(selected)) throw new Error(`RUNTIME_MODEL_${name}`);
  return selected;
};

const callTimeoutMs = (
  options: RuntimeModelGuardOptions,
  maxBufferMs: number,
  finalResponse: boolean,
): number => {
  const remaining = options.remainingTimeMs(finalResponse);
  if (!Number.isFinite(remaining) || remaining < 0) {
    throw new Error('RUNTIME_MODEL_REMAINING_TIME');
  }
  if (remaining === 0) {
    const denial = options.budget.checkAdmission(finalResponse);
    if (denial !== undefined) throw denialError(denial);
    throw new RuntimeModelGuardError('DEADLINE');
  }
  return Math.min(maxBufferMs, remaining);
};

const publicOperation = (name: string): boolean =>
  RUNTIME_PUBLIC_OPERATIONS.some((operation) => operation === name);

const guardErrorForBatch = (batch: RuntimeBatchResult): RuntimeModelGuardError => {
  if (batch.ok) throw new Error('runtime batch is already accepted');
  return new RuntimeModelGuardError(batch.issue.code, batch.issue.message);
};

const validateActions = (
  actions: readonly RuntimeBatchAction[],
  finalResponse = false,
): Extract<RuntimeBatchResult, { readonly ok: true }> => {
  if (finalResponse && actions.some((action) => action.kind === 'tool')) {
    throw new RuntimeModelGuardError('FINAL_WITH_TOOL');
  }
  const batch = validateRuntimeBatch(actions);
  if (!batch.ok) throw guardErrorForBatch(batch);
  return batch;
};

type ValidatedModelStep = {
  readonly batch: Extract<RuntimeBatchResult, { readonly ok: true }>;
  readonly finalText: string | null;
};

const actionsFromStream = (
  parts: readonly RuntimeModelGuardStreamPart[],
  finalResponse: boolean,
): ValidatedModelStep => {
  const finishes = parts.filter(
    (part): part is Extract<RuntimeModelGuardStreamPart, { type: 'finish' }> =>
      part.type === 'finish',
  );
  if (finishes.length !== 1) throw new RuntimeModelGuardError('FINISH_COUNT');

  const actions: RuntimeBatchAction[] = [];
  let text = '';
  let hasText = false;
  for (const part of parts) {
    if (!STREAM_PART_TYPES.has(part.type)) {
      throw new RuntimeModelGuardError('UNSUPPORTED_PART');
    }
    if (part.type === 'tool-input-start') {
      if (!publicOperation(part.toolName)) throw new RuntimeModelGuardError('UNKNOWN_TOOL');
      if (part.providerExecuted === true || part.dynamic === true) {
        throw new RuntimeModelGuardError('UNSUPPORTED_PART');
      }
    }
    if (part.type === 'tool-call') {
      if (part.providerExecuted === true || part.dynamic === true) {
        throw new RuntimeModelGuardError('UNSUPPORTED_PART');
      }
      actions.push({ kind: 'tool', operation: part.toolName });
    }
    if (part.type === 'text-delta') {
      hasText = true;
      text += part.delta;
    }
  }

  const finish = finishes[0];
  if (finish === undefined) throw new RuntimeModelGuardError('FINISH_COUNT');
  if (hasText || finish.finishReason.unified !== 'tool-calls') {
    actions.push({ kind: 'final', text });
  }
  const batch = validateActions(actions, finalResponse);
  return { batch, finalText: batch.terminal === 'message' ? text : null };
};

const actionsFromGenerate = (
  result: RuntimeModelGuardGenerateResult,
  maxParts: number,
  maxBytes: number,
  finalResponse: boolean,
): ValidatedModelStep => {
  if (result.content.length > maxParts) {
    throw new RuntimeModelGuardError('MODEL_STREAM_LIMIT');
  }
  const bytes = jsonBytes(result.content);
  if (bytes > maxBytes) throw new RuntimeModelGuardError('MODEL_STREAM_LIMIT');
  const actions: RuntimeBatchAction[] = [];
  let text = '';
  let hasText = false;
  for (const part of result.content) {
    if (part.type === 'text') {
      hasText = true;
      text += part.text;
    } else if (part.type === 'tool-call') {
      if (part.providerExecuted === true || part.dynamic === true) {
        throw new RuntimeModelGuardError('UNSUPPORTED_PART');
      }
      actions.push({ kind: 'tool', operation: part.toolName });
    } else if (part.type !== 'reasoning') {
      throw new RuntimeModelGuardError('UNSUPPORTED_PART');
    }
  }
  if (hasText || result.finishReason.unified !== 'tool-calls') {
    actions.push({ kind: 'final', text });
  }
  const batch = validateActions(actions, finalResponse);
  return { batch, finalText: batch.terminal === 'message' ? text : null };
};

const jsonBytes = (value: unknown): number => {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new RuntimeModelGuardError('MODEL_STREAM_LIMIT');
  }
  if (encoded === undefined) throw new RuntimeModelGuardError('MODEL_STREAM_LIMIT');
  return new TextEncoder().encode(encoded).byteLength;
};

const streamFrom = (
  parts: readonly RuntimeModelGuardStreamPart[],
): ReadableStream<RuntimeModelGuardStreamPart> =>
  new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });

type ManagedAbort = {
  readonly signal: AbortSignal;
  readonly finalResponse: boolean;
  readonly timedOut: () => boolean;
  readonly cleanup: () => void;
};

const managedSignals = new WeakMap<AbortSignal, ManagedAbort>();

const createManagedAbort = (
  caller: AbortSignal | undefined,
  timeoutMs: number,
  finalResponse: boolean,
): ManagedAbort => {
  const controller = new AbortController();
  let timedOut = false;
  let cleaned = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => controller.abort();
  if (caller?.aborted === true) onCallerAbort();
  else if (caller !== undefined) caller.addEventListener('abort', onCallerAbort, { once: true });
  const managed: ManagedAbort = {
    signal: controller.signal,
    finalResponse,
    timedOut: () => timedOut,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
      managedSignals.delete(controller.signal);
    },
  };
  managedSignals.set(controller.signal, managed);
  return managed;
};

const managedFor = (signal: AbortSignal | undefined): ManagedAbort | undefined =>
  signal === undefined ? undefined : managedSignals.get(signal);

const abortError = (managed: ManagedAbort | undefined, stream: boolean): RuntimeModelGuardError =>
  managed?.timedOut()
    ? new RuntimeModelGuardError('MODEL_STREAM_TIMEOUT')
    : new RuntimeModelGuardError(stream ? 'MODEL_STREAM_ABORTED' : 'CANCELLED');

const awaitProvider = async <T>(
  operation: PromiseLike<T>,
  managed: ManagedAbort | undefined,
  stream: boolean,
): Promise<T> => {
  const provider = Promise.resolve(operation);
  if (managed === undefined) return provider;
  if (managed.signal.aborted) {
    void provider.catch(() => undefined);
    throw abortError(managed, stream);
  }
  let removeAbort = (): void => undefined;
  const aborted = new Promise<T>((_, reject) => {
    const onAbort = (): void => reject(abortError(managed, stream));
    managed.signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = (): void => managed.signal.removeEventListener('abort', onAbort);
  });
  return Promise.race([provider, aborted]).finally(removeAbort);
};

const readBufferedStream = async (
  stream: ReadableStream<RuntimeModelGuardStreamPart>,
  managed: ManagedAbort | undefined,
  maxParts: number,
  maxBytes: number,
): Promise<{ readonly parts: readonly RuntimeModelGuardStreamPart[]; readonly bytes: number }> => {
  const signal = managed?.signal;
  const reader = stream.getReader();
  const parts: RuntimeModelGuardStreamPart[] = [];
  let bytes = 0;
  let stop: 'timeout' | 'aborted' | null = null;
  let removeAbortListener = (): void => undefined;
  const cancelReader = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  const onAbort = (): void => {
    if (stop === null) {
      stop = managed?.timedOut() === true ? 'timeout' : 'aborted';
    }
    cancelReader();
  };

  if (signal?.aborted === true) onAbort();
  else if (signal !== undefined) {
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = (): void => signal.removeEventListener('abort', onAbort);
  }
  try {
    while (true) {
      if (stop === 'aborted') throw new RuntimeModelGuardError('MODEL_STREAM_ABORTED');
      if (stop === 'timeout') throw new RuntimeModelGuardError('MODEL_STREAM_TIMEOUT');
      const next = await reader.read();
      if (stop === 'aborted') throw new RuntimeModelGuardError('MODEL_STREAM_ABORTED');
      if (stop === 'timeout') throw new RuntimeModelGuardError('MODEL_STREAM_TIMEOUT');
      if (next.done) break;
      if (parts.length >= maxParts) {
        cancelReader();
        throw new RuntimeModelGuardError('MODEL_STREAM_LIMIT');
      }
      const partBytes = jsonBytes(next.value);
      if (bytes + partBytes > maxBytes) {
        cancelReader();
        throw new RuntimeModelGuardError('MODEL_STREAM_LIMIT');
      }
      parts.push(next.value);
      bytes += partBytes;
    }
  } catch (error) {
    if (stop === 'aborted') throw new RuntimeModelGuardError('MODEL_STREAM_ABORTED');
    if (stop === 'timeout') throw new RuntimeModelGuardError('MODEL_STREAM_TIMEOUT');
    cancelReader();
    throw error;
  } finally {
    removeAbortListener();
    reader.releaseLock();
  }
  return { parts, bytes };
};

const denialError = (denial: RuntimeBudgetDenial): RuntimeModelGuardError =>
  new RuntimeModelGuardError(denial.code, denial.message);

const reserve = (budget: RuntimeModelGuardOptions['budget'], finalResponse: boolean): void => {
  const result: RuntimeBudgetResult<void> = budget.reserveModelStep(finalResponse);
  if (!result.ok) throw denialError(result.denial);
};

const checkAfterProvider = (
  budget: RuntimeModelGuardOptions['budget'],
  finalResponse: boolean,
): void => {
  const denial = budget.checkAdmission(finalResponse);
  if (denial !== undefined) throw denialError(denial);
};

const accepted = (
  step: ValidatedModelStep,
  partCount: number,
  bytes: number,
): RuntimeModelGuardAcceptance => ({
  terminal: step.batch.terminal,
  finalText: step.finalText,
  emptyFinal: step.batch.emptyFinal,
  partCount,
  bytes,
});

/**
 * Wraps one public AI SDK V3 model call. The provider output is fully buffered and checked before
 * the SDK can execute tools or invoke downstream step/metadata callbacks.
 */
export const wrapRuntimeModelGuard = (
  model: RuntimeModelGuardModel,
  options: RuntimeModelGuardOptions,
): RuntimeModelGuardModel => {
  const maxBufferMs = optionValue(options.maxBufferMs, DEFAULT_MAX_BUFFER_MS, 'BUFFER_TIMEOUT');
  const maxParts = optionValue(options.maxParts, DEFAULT_MAX_PARTS, 'MAX_PARTS');
  const maxBytes = optionValue(options.maxBytes, DEFAULT_MAX_BYTES, 'MAX_BYTES');

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v3',
      transformParams: ({ params }) => {
        try {
          if (isAborted(params.abortSignal)) throw new RuntimeModelGuardError('CANCELLED');
          const finalResponse = options.isFinalResponse?.(params) ?? false;
          const managed = createManagedAbort(
            params.abortSignal,
            callTimeoutMs(options, maxBufferMs, finalResponse),
            finalResponse,
          );
          return Promise.resolve({ ...params, abortSignal: managed.signal });
        } catch (error) {
          if (isRuntimeModelGuardError(error)) options.onFailure?.(error);
          throw error;
        }
      },
      wrapGenerate: async ({ doGenerate, params }) => {
        const managed = managedFor(params.abortSignal);
        try {
          const finalResponse =
            managed?.finalResponse ?? options.isFinalResponse?.(params) ?? false;
          if (isAborted(params.abortSignal)) {
            throw abortError(managed, false);
          }
          reserve(options.budget, finalResponse);
          const result = await awaitProvider(doGenerate(), managed, false);
          if (isAborted(params.abortSignal)) {
            throw abortError(managed, false);
          }
          checkAfterProvider(options.budget, finalResponse);
          const bytes = jsonBytes(result.content);
          const step = actionsFromGenerate(result, maxParts, maxBytes, finalResponse);
          options.onAccepted?.(accepted(step, result.content.length, bytes));
          return result;
        } catch (error) {
          if (isRuntimeModelGuardError(error)) options.onFailure?.(error);
          throw error;
        } finally {
          managed?.cleanup();
        }
      },
      wrapStream: async ({ doStream, params }) => {
        const managed = managedFor(params.abortSignal);
        try {
          const finalResponse =
            managed?.finalResponse ?? options.isFinalResponse?.(params) ?? false;
          if (isAborted(params.abortSignal)) {
            throw abortError(managed, false);
          }
          reserve(options.budget, finalResponse);
          const result = await awaitProvider(doStream(), managed, true);
          const buffered = await readBufferedStream(result.stream, managed, maxParts, maxBytes);
          if (isAborted(params.abortSignal)) {
            throw abortError(managed, true);
          }
          checkAfterProvider(options.budget, finalResponse);
          const step = actionsFromStream(buffered.parts, finalResponse);
          options.onAccepted?.(accepted(step, buffered.parts.length, buffered.bytes));
          return { ...result, stream: streamFrom(buffered.parts) };
        } catch (error) {
          if (isRuntimeModelGuardError(error)) options.onFailure?.(error);
          throw error;
        } finally {
          managed?.cleanup();
        }
      },
    },
  });
};
