export type RuntimeReadOperation = 'search_places' | 'get_place_details';

export type RuntimeBudgetConfig = {
  readonly wholeTurnMs: number;
  readonly finalReserveMs: number;
  readonly maxModelSteps: number;
  readonly maxReadCalls: number;
  readonly maxParallelReads: number;
  readonly maxProviderHttpRequests: number;
  readonly maxCostUnits: number;
  readonly maxRouteElements: number;
  readonly maxReadRetries: number;
  readonly maxRepairAttempts: number;
  readonly searchTimeoutMs: number;
  readonly detailsTimeoutMs: number;
  readonly sdkRetryLimit: number;
};

/** Initial M10 limits. Provider-specific prices are injected through the request costs. */
export const DEFAULT_RUNTIME_BUDGET: RuntimeBudgetConfig = Object.freeze({
  wholeTurnMs: 12_000,
  finalReserveMs: 2_000,
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

export type RuntimeBudgetSnapshot = {
  readonly modelSteps: number;
  readonly readCalls: number;
  readonly activeReads: number;
  readonly providerHttpRequests: number;
  readonly costUnits: number;
  readonly routeElements: number;
  readonly readRetries: number;
  readonly submitAttempts: number;
  readonly remainingRepairs: number;
  readonly deadlineAtMs: number;
  readonly finalReserveAtMs: number;
  readonly completed: boolean;
};

export type RuntimeBudgetDenialCode =
  | 'CANCELLED'
  | 'STALE_TURN'
  | 'DEADLINE'
  | 'FINAL_RESERVE'
  | 'BUDGET_EXCEEDED'
  | 'PARALLEL_LIMIT'
  | 'COMMITTED'
  | 'RETRY_NOT_ALLOWED';

export type RuntimeBudgetDenial = {
  readonly code: RuntimeBudgetDenialCode;
  readonly message: string;
};

export type RuntimeBudgetResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly denial: RuntimeBudgetDenial };

export type RuntimeReadReservationRequest = {
  readonly operation: RuntimeReadOperation;
  readonly costUnits: number;
  readonly providerHttpRequests: number;
  readonly routeElements: number;
};

export type RuntimeRetryFailure =
  'transport' | 'server' | 'rate_limited' | 'argument' | 'reference';

export type RuntimeRetryResult =
  | { readonly ok: true; readonly delayMs: number }
  | { readonly ok: false; readonly denial: RuntimeBudgetDenial };

export type RuntimeReservation = {
  readonly release: () => void;
};

export type RuntimeReadReservation = RuntimeReservation & {
  readonly operation: RuntimeReadOperation;
  readonly retry: (failure: RuntimeRetryFailure, retryAfterMs?: number) => RuntimeRetryResult;
};

export type RuntimeSubmitReservation = {
  /** First submit gets the full repair allowance; each later submit consumes one repair. */
  readonly remainingRepairs: number;
};

export type RuntimeBudgetOptions = {
  readonly config?: RuntimeBudgetConfig;
  readonly startedAtMs?: number;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly isStale?: () => boolean;
};

const validNonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const validRequest = (request: RuntimeReadReservationRequest): boolean =>
  request.operation.length > 0 &&
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

  reserveModelStep(finalResponse = false): RuntimeBudgetResult<void> {
    const blocked = this.admission(finalResponse);
    if (blocked !== undefined) return { ok: false, denial: blocked };
    if (this.modelSteps >= this.config.maxModelSteps) {
      return { ok: false, denial: denial('BUDGET_EXCEEDED', 'model step budget is exhausted') };
    }
    this.modelSteps += 1;
    return { ok: true, value: undefined };
  }

  reserveRead(request: RuntimeReadReservationRequest): RuntimeBudgetResult<RuntimeReadReservation> {
    if (!validRequest(request)) {
      return { ok: false, denial: denial('BUDGET_EXCEEDED', 'read reservation is invalid') };
    }
    const operation = request.operation;
    const reservedCostUnits = request.costUnits;
    const reservedProviderHttpRequests = request.providerHttpRequests;
    const reservedRouteElements = request.routeElements;
    const blocked = this.admission(false);
    if (blocked !== undefined) return { ok: false, denial: blocked };
    if (this.activeReads >= this.config.maxParallelReads) {
      return { ok: false, denial: denial('PARALLEL_LIMIT', 'read parallelism is exhausted') };
    }
    if (this.readCalls >= this.config.maxReadCalls) {
      return { ok: false, denial: denial('BUDGET_EXCEEDED', 'read call budget is exhausted') };
    }
    if (!this.fits(reservedCostUnits, reservedProviderHttpRequests, reservedRouteElements)) {
      return { ok: false, denial: denial('BUDGET_EXCEEDED', 'read cost budget is exhausted') };
    }

    this.readCalls += 1;
    this.activeReads += 1;
    this.costUnits += reservedCostUnits;
    this.providerHttpRequests += reservedProviderHttpRequests;
    this.routeElements += reservedRouteElements;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.activeReads -= 1;
    };
    const retry = (failure: RuntimeRetryFailure, retryAfterMs = 0): RuntimeRetryResult => {
      if (released) {
        return {
          ok: false,
          denial: denial('RETRY_NOT_ALLOWED', 'released reads cannot be retried'),
        };
      }
      const blocked = this.admission(false);
      if (blocked !== undefined) return { ok: false, denial: blocked };
      if (failure === 'argument' || failure === 'reference') {
        return {
          ok: false,
          denial: denial('RETRY_NOT_ALLOWED', 'argument and reference failures are not retried'),
        };
      }
      if (!validNonNegativeInteger(retryAfterMs)) {
        return {
          ok: false,
          denial: denial('RETRY_NOT_ALLOWED', 'retry-after must be a non-negative integer'),
        };
      }
      if (this.readRetries >= this.config.maxReadRetries) {
        return { ok: false, denial: denial('BUDGET_EXCEEDED', 'read retry budget is exhausted') };
      }
      if (!this.fits(reservedCostUnits, reservedProviderHttpRequests, reservedRouteElements)) {
        return {
          ok: false,
          denial: denial('BUDGET_EXCEEDED', 'provider HTTP request budget is exhausted'),
        };
      }
      const waitUntil = this.currentTime() + retryAfterMs;
      if (waitUntil > this.finalReserveAtMs) {
        return {
          ok: false,
          denial: denial('FINAL_RESERVE', 'retry-after would consume the final response reserve'),
        };
      }
      this.readRetries += 1;
      this.costUnits += reservedCostUnits;
      this.providerHttpRequests += reservedProviderHttpRequests;
      this.routeElements += reservedRouteElements;
      return { ok: true, delayMs: retryAfterMs };
    };
    return {
      ok: true,
      value: { operation, release, retry },
    };
  }

  reserveSubmit(): RuntimeBudgetResult<RuntimeSubmitReservation> {
    const blocked = this.admission(true);
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

  private admission(finalResponse: boolean): RuntimeBudgetDenial | undefined {
    if (this.completed) return denial('COMMITTED', 'turn already has a committed response');
    if (this.isStale?.() === true) {
      this.cancelledCode = 'STALE_TURN';
      return denial('STALE_TURN', 'turn revision is stale');
    }
    if (this.cancelledCode !== null || this.signal?.aborted === true) {
      this.cancelledCode = 'CANCELLED';
      return denial('CANCELLED', 'turn was cancelled');
    }
    const now = this.currentTime();
    if (now >= this.deadlineAtMs) return denial('DEADLINE', 'turn wall-clock budget is exhausted');
    if (!finalResponse && now >= this.finalReserveAtMs) {
      return denial('FINAL_RESERVE', 'final response reserve is active');
    }
    return undefined;
  }

  private fits(costUnits: number, providerHttpRequests: number, routeElements: number): boolean {
    return (
      this.providerHttpRequests + providerHttpRequests <= this.config.maxProviderHttpRequests &&
      this.costUnits + costUnits <= this.config.maxCostUnits &&
      this.routeElements + routeElements <= this.config.maxRouteElements
    );
  }

  private currentTime(): number {
    const observed = this.now();
    if (!validClockValue(observed)) return this.deadlineAtMs;
    this.lastNowMs = Math.max(this.lastNowMs, observed);
    return this.lastNowMs;
  }
}
