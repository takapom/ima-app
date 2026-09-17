import {
  consumeRuntimePendingRead,
  createRuntimeReadReservation,
} from '@api/runtime/budget/runtime-budget-read';
import { createRuntimeRouteReservation } from '@api/runtime/budget/runtime-budget-route';
import type {
  RuntimeBudgetConfig,
  RuntimeBudgetDenial,
  RuntimeBudgetDenialCode,
  RuntimeBudgetOptions,
  RuntimeBudgetResult,
  RuntimeBudgetSnapshot,
  RuntimeReadReservation,
  RuntimeReadReservationRequest,
  RuntimeRouteReservation,
  RuntimeRouteReservationRequest,
  RuntimeSubmitReservation,
} from '@api/runtime/budget/runtime-budget-types';
export type {
  RuntimeBudgetConfig,
  RuntimeBudgetDenial,
  RuntimeBudgetDenialCode,
  RuntimeBudgetOperation,
  RuntimeBudgetOptions,
  RuntimeBudgetResult,
  RuntimeBudgetSnapshot,
  RuntimeReadReservation,
  RuntimeReadReservationRequest,
  RuntimeReadOperation,
  RuntimeReservation,
  RuntimeRetryFailure,
  RuntimeRetryResult,
  RuntimeRouteReservation,
  RuntimeRouteReservationRequest,
  RuntimeSubmitReservation,
} from '@api/runtime/budget/runtime-budget-types';

/** Initial M10 limits. Provider-specific prices are injected through the request costs. */
export const DEFAULT_RUNTIME_BUDGET: RuntimeBudgetConfig = Object.freeze({
  wholeTurnMs: 60_000,
  finalReserveMs: 10_000,
  maxModelSteps: 6,
  maxReadCalls: 8,
  maxParallelReads: 2,
  maxProviderHttpRequests: 20,
  maxCostUnits: 20,
  maxRouteElements: 8,
  maxReadRetries: 1,
  maxRepairAttempts: 2,
  searchTimeoutMs: 3_000,
  detailsTimeoutMs: 4_000,
  sdkRetryLimit: 0,
});

type PendingReadSignal = {
  readonly controller: AbortController;
};

const validNonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const validRequest = (request: RuntimeReadReservationRequest): boolean =>
  request.operation.length > 0 &&
  (request.callId === undefined || request.callId.length > 0) &&
  validNonNegativeInteger(request.costUnits) &&
  validNonNegativeInteger(request.providerHttpRequests) &&
  validNonNegativeInteger(request.routeElements);

const denial = (code: RuntimeBudgetDenialCode, message: string): RuntimeBudgetDenial => ({
  code,
  message,
});

const validLimit = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const validPositiveLimit = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const validClockValue = (value: number): boolean => Number.isFinite(value) && value >= 0;

const assertConfig = (config: RuntimeBudgetConfig): RuntimeBudgetConfig => {
  const positive = [
    config.wholeTurnMs,
    config.maxModelSteps,
    config.maxReadCalls,
    config.maxParallelReads,
    config.maxProviderHttpRequests,
    config.searchTimeoutMs,
    config.detailsTimeoutMs,
  ];
  if (!positive.every(validPositiveLimit)) throw new Error('RUNTIME_BUDGET_CONFIGURATION');
  if (
    !validLimit(config.finalReserveMs) ||
    config.finalReserveMs >= config.wholeTurnMs ||
    !validLimit(config.maxCostUnits) ||
    !validLimit(config.maxRouteElements) ||
    !validLimit(config.maxReadRetries) ||
    config.maxReadRetries > 1 ||
    !validLimit(config.maxRepairAttempts) ||
    config.maxRepairAttempts > 2 ||
    config.sdkRetryLimit !== 0
  ) {
    throw new Error('RUNTIME_BUDGET_CONFIGURATION');
  }
  return Object.freeze({ ...config });
};

/**
 * Per-turn accounting used by the Worker adapter. It reserves all declared costs before an
 * external read starts; releasing a lease only releases its concurrency slot, never a paid
 * attempt that has already been admitted.
 */
export class RuntimeBudget {
  private readonly config: RuntimeBudgetConfig;
  private readonly now: () => number;
  private readonly signal: AbortSignal | undefined;
  private readonly isStale: (() => boolean) | undefined;
  private readonly startedAtMs: number;
  private readonly deadlineAtMs: number;
  private readonly finalReserveAtMs: number;
  private lastNowMs: number;
  private modelSteps = 0;
  private readCalls = 0;
  private activeReads = 0;
  private providerHttpRequests = 0;
  private costUnits = 0;
  private routeElements = 0;
  private readRetries = 0;
  private submitAttempts = 0;
  private cancelledCode: 'CANCELLED' | 'STALE_TURN' | null = null;
  private completed = false;
  private readonly pendingReadSlots = new Map<string, () => void>();
  private readonly pendingReadSignals = new Map<string, PendingReadSignal>();

  constructor(options: RuntimeBudgetOptions = {}) {
    this.config = assertConfig(options.config ?? DEFAULT_RUNTIME_BUDGET);
    this.now = options.now ?? (() => performance.now());
    const startedAtMs = options.startedAtMs ?? this.now();
    if (!validClockValue(startedAtMs)) throw new Error('RUNTIME_BUDGET_CLOCK');
    this.startedAtMs = startedAtMs;
    this.deadlineAtMs = this.startedAtMs + this.config.wholeTurnMs;
    this.finalReserveAtMs = this.deadlineAtMs - this.config.finalReserveMs;
    this.lastNowMs = startedAtMs;
    this.signal = options.signal;
    this.isStale = options.isStale;
  }

  get limits(): RuntimeBudgetConfig {
    return this.config;
  }
  cancel(): void {
    this.cancelledCode = 'CANCELLED';
    for (const signal of this.pendingReadSignals.values()) signal.controller.abort();
    for (const callId of this.pendingReadSlots.keys()) this.releaseReadSlot(callId);
  }

  markCommitted(): void {
    this.completed = true;
  }

  isCancelled(): boolean {
    return (
      this.cancelledCode !== null || this.signal?.aborted === true || this.isStale?.() === true
    );
  }

  snapshot(): RuntimeBudgetSnapshot {
    return {
      modelSteps: this.modelSteps,
      readCalls: this.readCalls,
      activeReads: this.activeReads,
      providerHttpRequests: this.providerHttpRequests,
      costUnits: this.costUnits,
      routeElements: this.routeElements,
      readRetries: this.readRetries,
      submitAttempts: this.submitAttempts,
      remainingRepairs: Math.max(
        0,
        this.config.maxRepairAttempts - Math.max(0, this.submitAttempts - 1),
      ),
      deadlineAtMs: this.deadlineAtMs,
      finalReserveAtMs: this.finalReserveAtMs,
      completed: this.completed,
    };
  }

  /** Returns the provider-call wall-clock allowance using this budget's monotonic clock. */
  remainingModelTimeMs(finalResponse = false): number {
    const limit = finalResponse ? this.deadlineAtMs : this.finalReserveAtMs;
    return Math.max(0, limit - this.monotonicTime());
  }

  /** Returns the admission decision without reserving counters or changing cancellation state. */
  checkAdmission(finalResponse = false): RuntimeBudgetDenial | undefined {
    if (this.completed) return denial('COMMITTED', 'turn already has a committed response');
    if (this.isStale?.() === true) return denial('STALE_TURN', 'turn revision is stale');
    if (this.cancelledCode !== null || this.signal?.aborted === true) {
      return denial('CANCELLED', 'turn was cancelled');
    }
    const now = this.monotonicTime();
    if (now >= this.deadlineAtMs) return denial('DEADLINE', 'turn wall-clock budget is exhausted');
    if (!finalResponse && now >= this.finalReserveAtMs) {
      return denial('FINAL_RESERVE', 'final response reserve is active');
    }
    return undefined;
  }

  /** Read operations must fit before the final response reserve begins. */
  remainingReadTimeMs(): number {
    return Math.max(0, this.finalReserveAtMs - this.monotonicTime());
  }

  reserveModelStep(finalResponse = false): RuntimeBudgetResult<void> {
    const blocked = this.checkAdmission(finalResponse);
    if (blocked !== undefined) return { ok: false, denial: blocked };
    if (this.modelSteps >= this.config.maxModelSteps) {
      return { ok: false, denial: denial('BUDGET_EXCEEDED', 'model step budget is exhausted') };
    }
    this.modelSteps += 1;
    return { ok: true, value: undefined };
  }

  /** Reserves one provider fetch performed by an already-admitted model tool read. */
  reserveProviderRequest(): RuntimeBudgetResult<void> {
    const blocked = this.checkAdmission(false);
    if (blocked !== undefined) return { ok: false, denial: blocked };
    if (this.activeReads === 0) {
      return {
        ok: false,
        denial: denial('BUDGET_EXCEEDED', 'provider request requires an admitted read'),
      };
    }
    if (!this.fits(1, 1, 0)) {
      return {
        ok: false,
        denial: denial('BUDGET_EXCEEDED', 'provider HTTP request budget is exhausted'),
      };
    }
    this.providerHttpRequests += 1;
    this.costUnits += 1;
    return { ok: true, value: undefined };
  }

  /** Reserves only the read slot before a resolver can perform work needed to derive read input. */
  reserveReadSlot(callId: string, externalSignal?: AbortSignal): RuntimeBudgetResult<void> {
    if (callId.length === 0 || this.pendingReadSlots.has(callId)) {
      return { ok: false, denial: denial('BUDGET_EXCEEDED', 'read slot identity is invalid') };
    }
    if (externalSignal?.aborted === true) {
      return { ok: false, denial: denial('CANCELLED', 'read was cancelled') };
    }
    const blocked = this.checkAdmission(false);
    if (blocked !== undefined) return { ok: false, denial: blocked };
    if (this.activeReads >= this.config.maxParallelReads) {
      return { ok: false, denial: denial('PARALLEL_LIMIT', 'read parallelism is exhausted') };
    }
    if (this.readCalls >= this.config.maxReadCalls) {
      return { ok: false, denial: denial('BUDGET_EXCEEDED', 'read call budget is exhausted') };
    }
    this.readCalls += 1;
    this.activeReads += 1;
    const controller = new AbortController();
    const timeoutMs = Math.max(
      1,
      Math.min(this.config.detailsTimeoutMs, this.remainingReadTimeMs()),
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    let removeExternalAbort = (): void => undefined;
    if (externalSignal !== undefined) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      removeExternalAbort = (): void =>
        externalSignal.removeEventListener('abort', onExternalAbort);
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      removeExternalAbort();
      this.pendingReadSignals.delete(callId);
      this.activeReads -= 1;
    };
    this.pendingReadSlots.set(callId, release);
    this.pendingReadSignals.set(callId, { controller });
    return { ok: true, value: undefined };
  }

  readSignalFor(callId: string): AbortSignal | undefined {
    return this.pendingReadSignals.get(callId)?.controller.signal;
  }

  releaseReadSlot(callId: string): void {
    const release = this.pendingReadSlots.get(callId);
    if (release === undefined) return;
    this.pendingReadSlots.delete(callId);
    release();
  }

  reserveRead(request: RuntimeReadReservationRequest): RuntimeBudgetResult<RuntimeReadReservation> {
    if (!validRequest(request)) {
      return { ok: false, denial: denial('BUDGET_EXCEEDED', 'read reservation is invalid') };
    }
    const pending =
      request.callId === undefined ? undefined : this.pendingReadSlots.get(request.callId);
    if (pending !== undefined && request.callId !== undefined) {
      return this.consumePendingRead(request.callId, request, pending);
    }
    const blocked = this.checkAdmission(false);
    if (blocked !== undefined) return { ok: false, denial: blocked };
    if (this.activeReads >= this.config.maxParallelReads) {
      return { ok: false, denial: denial('PARALLEL_LIMIT', 'read parallelism is exhausted') };
    }
    if (this.readCalls >= this.config.maxReadCalls) {
      return { ok: false, denial: denial('BUDGET_EXCEEDED', 'read call budget is exhausted') };
    }
    if (!this.fits(request.costUnits, request.providerHttpRequests, request.routeElements)) {
      return { ok: false, denial: denial('BUDGET_EXCEEDED', 'read cost budget is exhausted') };
    }

    this.readCalls += 1;
    this.activeReads += 1;
    this.costUnits += request.costUnits;
    this.providerHttpRequests += request.providerHttpRequests;
    this.routeElements += request.routeElements;
    return {
      ok: true,
      value: this.readReservation(request, () => {
        this.activeReads -= 1;
      }),
    };
  }

  private consumePendingRead(
    callId: string,
    request: RuntimeReadReservationRequest,
    releaseActive: () => void,
  ): RuntimeBudgetResult<RuntimeReadReservation> {
    return consumeRuntimePendingRead({
      callId,
      request,
      releaseActive,
      checkAdmission: () => this.checkAdmission(false),
      fits: (costUnits, providerHttpRequests, routeElements) =>
        this.fits(costUnits, providerHttpRequests, routeElements),
      addCosts: (costs) => {
        this.costUnits += costs.costUnits;
        this.providerHttpRequests += costs.providerHttpRequests;
        this.routeElements += costs.routeElements;
      },
      removePending: (pendingCallId) => this.pendingReadSlots.delete(pendingCallId),
      readReservation: (pendingRequest, release) => this.readReservation(pendingRequest, release),
    });
  }

  private readReservation(
    request: RuntimeReadReservationRequest,
    releaseActive: () => void,
  ): RuntimeReadReservation {
    return createRuntimeReadReservation({
      request,
      releaseActive,
      checkAdmission: () => this.checkAdmission(false),
      fits: (costUnits, providerHttpRequests, routeElements) =>
        this.fits(costUnits, providerHttpRequests, routeElements),
      finalReserveAtMs: this.finalReserveAtMs,
      maxReadRetries: this.config.maxReadRetries,
      readRetries: () => this.readRetries,
      incrementReadRetries: () => {
        this.readRetries += 1;
      },
      addCosts: (costs) => {
        this.costUnits += costs.costUnits;
        this.providerHttpRequests += costs.providerHttpRequests;
        this.routeElements += costs.routeElements;
      },
      monotonicTime: () => this.monotonicTime(),
    });
  }

  reserveRoute(
    request: RuntimeRouteReservationRequest,
  ): RuntimeBudgetResult<RuntimeRouteReservation> {
    return createRuntimeRouteReservation(
      request,
      (readRequest) => this.reserveRead(readRequest),
      () => this.checkAdmission(false),
    );
  }

  reserveSubmit(): RuntimeBudgetResult<RuntimeSubmitReservation> {
    const blocked = this.checkAdmission(true);
    if (blocked !== undefined) return { ok: false, denial: blocked };
    const attempt = this.submitAttempts;
    if (attempt > this.config.maxRepairAttempts) {
      return { ok: false, denial: denial('BUDGET_EXCEEDED', 'submit repair budget is exhausted') };
    }
    this.submitAttempts += 1;
    return {
      ok: true,
      value: {
        remainingRepairs: Math.max(0, this.config.maxRepairAttempts - attempt),
      },
    };
  }

  private fits(costUnits: number, providerHttpRequests: number, routeElements: number): boolean {
    return (
      this.providerHttpRequests + providerHttpRequests <= this.config.maxProviderHttpRequests &&
      this.costUnits + costUnits <= this.config.maxCostUnits &&
      this.routeElements + routeElements <= this.config.maxRouteElements
    );
  }

  private monotonicTime(): number {
    const observed = this.now();
    if (!validClockValue(observed)) return this.deadlineAtMs;
    this.lastNowMs = Math.max(this.lastNowMs, observed);
    return this.lastNowMs;
  }
}
