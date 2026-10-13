export type RuntimeReadOperation = 'search_places' | 'get_place_details';

export type RuntimeBudgetConfig = {
  readonly wholeTurnMs: number;
  readonly finalReserveMs: number;
  readonly maxModelSteps: number;
  readonly maxReadCalls: number;
  readonly maxParallelReads: number;
  readonly maxProviderHttpRequests: number;
  readonly maxCostUnits: number;
  readonly maxReadRetries: number;
  readonly maxRepairAttempts: number;
  readonly searchTimeoutMs: number;
  readonly detailsTimeoutMs: number;
  readonly sdkRetryLimit: number;
};

export type RuntimeBudgetSnapshot = {
  readonly modelSteps: number;
  readonly readCalls: number;
  readonly activeReads: number;
  readonly providerHttpRequests: number;
  readonly costUnits: number;
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
  readonly callId?: string;
  readonly operation: RuntimeReadOperation;
  readonly costUnits: number;
  readonly providerHttpRequests: number;
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
