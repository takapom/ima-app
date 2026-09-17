import type {
  RuntimeBudget,
  RuntimeBudgetDenial,
  RuntimeReadOperation,
  RuntimeRetryFailure,
} from '../budget/runtime-budget';
import { RuntimeSingleFlight } from './runtime-singleflight';

export type RuntimeReadFailureKind =
  'timeout' | 'transport' | 'server' | 'rate_limited' | 'argument' | 'reference';

export type RuntimeReadFailureOptions = {
  readonly retryAfterMs?: number | null;
};

/** Expected upstream failures are explicit so arbitrary provider exceptions still propagate. */
export class RuntimeReadFailure extends Error {
  readonly kind: RuntimeReadFailureKind;
  readonly retryAfterMs: number | null;

  constructor(kind: RuntimeReadFailureKind, options: RuntimeReadFailureOptions = {}) {
    super(`runtime read failed: ${kind}`);
    this.name = 'RuntimeReadFailure';
    this.kind = kind;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export type RuntimeReadExecutionRequest<T> = {
  readonly callId: string;
  /** Caller derives this from scope, canonical input, context, and freshness. */
  readonly flightKey: string;
  readonly operation: RuntimeReadOperation;
  readonly costUnits: number;
  readonly providerHttpRequests: number;
  readonly routeElements: number;
  readonly invoke: (signal: AbortSignal) => Promise<T>;
};

export type RuntimeReadExecutionResult<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: number }
  | { readonly ok: false; readonly denial: RuntimeBudgetDenial; readonly attempts: number }
  | {
      readonly ok: false;
      readonly failure: RuntimeReadFailure;
      readonly attempts: number;
      readonly retryDenial: RuntimeBudgetDenial | null;
    };

export type RuntimeReadExecutorOptions<T> = {
  readonly budget: RuntimeBudget;
  readonly singleFlight?: RuntimeSingleFlight<RuntimeReadExecutionResult<T>>;
  readonly signal?: AbortSignal;
  readonly isStale?: () => boolean;
};

class RuntimeReadExecutionDenied extends Error {
  readonly denial: RuntimeBudgetDenial;

  constructor(denial: RuntimeBudgetDenial) {
    super(denial.message);
    this.name = 'RuntimeReadExecutionDenied';
    this.denial = denial;
  }
}

class RuntimeReadCancelled extends Error {
  constructor() {
    super('runtime read cancelled');
    this.name = 'RuntimeReadCancelled';
  }
}

const retryKind = (failure: RuntimeReadFailure): RuntimeRetryFailure | undefined => {
  if (failure.kind === 'timeout') return 'transport';
  if (failure.kind === 'transport') return 'transport';
  if (failure.kind === 'server') return 'server';
  if (failure.kind === 'rate_limited') return 'rate_limited';
  return undefined;
};

const denial = (code: RuntimeBudgetDenial['code'], message: string): RuntimeBudgetDenial => ({
  code,
  message,
});

/**
 * Executes one explicitly supplied read operation. The SDK/Tool loop remains the caller's
 * responsibility; this class only owns admission, timeout, one permitted retry, and flight
 * sharing for a read.
 */
export class RuntimeReadExecutor<T> {
  private readonly budget: RuntimeBudget;
  private readonly signal: AbortSignal | undefined;
  private readonly isStale: (() => boolean) | undefined;
  private readonly flight: RuntimeSingleFlight<RuntimeReadExecutionResult<T>>;
  private readonly disposeController = new AbortController();
  private disposed = false;

  constructor(options: RuntimeReadExecutorOptions<T>) {
    this.budget = options.budget;
    this.signal = options.signal;
    this.isStale = options.isStale;
    this.flight =
      options.singleFlight ??
      new RuntimeSingleFlight<RuntimeReadExecutionResult<T>>({
        isCancelled: () =>
          this.disposed ||
          this.disposeController.signal.aborted ||
          this.signal?.aborted === true ||
          this.budget.isCancelled(),
        isStale: () => this.isStale?.() === true,
      });
  }

  execute(request: RuntimeReadExecutionRequest<T>): Promise<RuntimeReadExecutionResult<T>> {
    return this.flight.execute(request.callId, request.flightKey, () => this.executeRead(request));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeController.abort();
    this.flight.dispose();
  }

  private async executeRead(
    request: RuntimeReadExecutionRequest<T>,
  ): Promise<RuntimeReadExecutionResult<T>> {
    const reservation = this.budget.reserveRead({
      callId: request.callId,
      operation: request.operation,
      costUnits: request.costUnits,
      providerHttpRequests: request.providerHttpRequests,
      routeElements: request.routeElements,
    });
    if (!reservation.ok) return { ok: false, denial: reservation.denial, attempts: 0 };

    let attempts = 0;
    try {
      while (true) {
        const blocked = this.currentDenial(request.callId);
        if (blocked !== undefined) return { ok: false, denial: blocked, attempts };
        attempts += 1;
        try {
          const value = await this.runAttempt(request, this.timeoutFor(request.operation));
          const afterAttempt = this.currentDenial(request.callId);
          if (afterAttempt !== undefined) {
            return { ok: false, denial: afterAttempt, attempts };
          }
          return { ok: true, value, attempts };
        } catch (error) {
          if (error instanceof RuntimeReadExecutionDenied) {
            return { ok: false, denial: error.denial, attempts: attempts - 1 };
          }
          if (error instanceof RuntimeReadCancelled) {
            return {
              ok: false,
              denial: denial('CANCELLED', 'read was cancelled'),
              attempts,
            };
          }
          const blockedAfterFailure = this.currentDenial(request.callId);
          if (blockedAfterFailure !== undefined) {
            return { ok: false, denial: blockedAfterFailure, attempts };
          }
          if (!(error instanceof RuntimeReadFailure)) throw error;
          const failure = error;
          const kind = retryKind(failure);
          if (
            kind === undefined ||
            (failure.kind === 'rate_limited' && failure.retryAfterMs === null)
          ) {
            return { ok: false, failure, attempts, retryDenial: null };
          }
          const retry = reservation.value.retry(kind, failure.retryAfterMs ?? 0);
          if (!retry.ok) return { ok: false, failure, attempts, retryDenial: retry.denial };
          try {
            await this.wait(retry.delayMs, request.callId);
          } catch (error) {
            if (error instanceof RuntimeReadExecutionDenied) {
              return { ok: false, denial: error.denial, attempts };
            }
            throw error;
          }
        }
      }
    } finally {
      reservation.value.release();
    }
  }

  private timeoutFor(operation: RuntimeReadOperation): number {
    const configured =
      operation === 'search_places'
        ? this.budget.limits.searchTimeoutMs
        : this.budget.limits.detailsTimeoutMs;
    return Math.min(configured, this.budget.remainingReadTimeMs());
  }

  private currentDenial(callId?: string): RuntimeBudgetDenial | undefined {
    if (this.disposed) return denial('CANCELLED', 'turn was cancelled');
    if (this.isStale?.() === true) return denial('STALE_TURN', 'turn revision is stale');
    if (this.signal?.aborted === true) return denial('CANCELLED', 'turn was cancelled');
    if (callId !== undefined && this.budget.readSignalFor(callId)?.aborted === true) {
      return denial('CANCELLED', 'read was cancelled');
    }
    return this.budget.checkAdmission(false);
  }

  private async runAttempt(request: RuntimeReadExecutionRequest<T>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener = (): void => undefined;
    const abortSignals = this.abortSignals(request.callId);
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        externallyAborted = true;
        controller.abort();
        reject(new RuntimeReadCancelled());
      };
      removeAbortListener = (): void =>
        abortSignals.forEach((signal) => signal.removeEventListener('abort', onAbort));
      if (abortSignals.some((signal) => signal.aborted)) onAbort();
      else
        abortSignals.forEach((signal) => signal.addEventListener('abort', onAbort, { once: true }));
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new RuntimeReadFailure('timeout'));
      }, timeoutMs);
    });
    const invokePromise = Promise.resolve().then(() => {
      const blocked = this.currentDenial(request.callId);
      if (blocked !== undefined) throw new RuntimeReadExecutionDenied(blocked);
      return request.invoke(controller.signal);
    });
    const promises = [invokePromise, timeoutPromise, abortPromise];
    try {
      return await Promise.race(promises);
    } catch (error) {
      if (timedOut) throw new RuntimeReadFailure('timeout');
      if (externallyAborted) throw new RuntimeReadCancelled();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbortListener();
    }
  }

  private async wait(delayMs: number, callId?: string): Promise<void> {
    if (delayMs === 0) {
      const blocked = this.currentDenial(callId);
      if (blocked !== undefined) throw new RuntimeReadExecutionDenied(blocked);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const abortSignals = this.abortSignals(callId);
      let cleanup = (): void => undefined;
      const finish = (): void => {
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const blocked = this.currentDenial(callId) ?? denial('CANCELLED', 'turn was cancelled');
        reject(new RuntimeReadExecutionDenied(blocked));
      };
      if (abortSignals.some((signal) => signal.aborted)) {
        onAbort();
        return;
      }
      const timer = setTimeout(finish, delayMs);
      cleanup = (): void => {
        clearTimeout(timer);
        abortSignals.forEach((signal) => signal.removeEventListener('abort', onAbort));
      };
      abortSignals.forEach((signal) => signal.addEventListener('abort', onAbort, { once: true }));
    });
    const blocked = this.currentDenial(callId);
    if (blocked !== undefined) throw new RuntimeReadExecutionDenied(blocked);
  }

  private abortSignals(callId?: string): AbortSignal[] {
    const signals =
      this.signal === undefined
        ? [this.disposeController.signal]
        : [this.disposeController.signal, this.signal];
    const readSignal = callId === undefined ? undefined : this.budget.readSignalFor(callId);
    return readSignal === undefined ? signals : [...signals, readSignal];
  }
}
