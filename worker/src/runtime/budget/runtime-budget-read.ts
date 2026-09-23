import type {
  RuntimeBudgetDenial,
  RuntimeBudgetResult,
  RuntimeReadReservation,
  RuntimeReadReservationRequest,
  RuntimeRetryFailure,
  RuntimeRetryResult,
} from '@worker/runtime/budget/runtime-budget-types';

type ReadAccounting = {
  readonly request: RuntimeReadReservationRequest;
  readonly releaseActive: () => void;
  readonly checkAdmission: () => RuntimeBudgetDenial | undefined;
  readonly fits: (costUnits: number, providerHttpRequests: number) => boolean;
  readonly finalReserveAtMs: number;
  readonly maxReadRetries: number;
  readonly readRetries: () => number;
  readonly incrementReadRetries: () => void;
  readonly addCosts: (request: RuntimeReadReservationRequest) => void;
  readonly monotonicTime: () => number;
};

type PendingReadAccounting = {
  readonly request: RuntimeReadReservationRequest;
  readonly releaseActive: () => void;
  readonly checkAdmission: () => RuntimeBudgetDenial | undefined;
  readonly fits: (costUnits: number, providerHttpRequests: number) => boolean;
  readonly addCosts: (request: RuntimeReadReservationRequest) => void;
};

const denial = (code: RuntimeBudgetDenial['code'], message: string): RuntimeBudgetDenial => ({
  code,
  message,
});

const validRetryAfter = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export const createRuntimeReadReservation = ({
  request,
  releaseActive,
  checkAdmission,
  fits,
  finalReserveAtMs,
  maxReadRetries,
  readRetries,
  incrementReadRetries,
  addCosts,
  monotonicTime,
}: ReadAccounting): RuntimeReadReservation => {
  const reservedCostUnits = request.costUnits;
  const reservedProviderHttpRequests = request.providerHttpRequests;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseActive();
  };
  const retry = (failure: RuntimeRetryFailure, retryAfterMs = 0): RuntimeRetryResult => {
    if (released) {
      return {
        ok: false,
        denial: denial('RETRY_NOT_ALLOWED', 'released reads cannot be retried'),
      };
    }
    const blocked = checkAdmission();
    if (blocked !== undefined) return { ok: false, denial: blocked };
    if (failure === 'argument' || failure === 'reference') {
      return {
        ok: false,
        denial: denial('RETRY_NOT_ALLOWED', 'argument and reference failures are not retried'),
      };
    }
    if (!validRetryAfter(retryAfterMs)) {
      return {
        ok: false,
        denial: denial('RETRY_NOT_ALLOWED', 'retry-after must be a non-negative integer'),
      };
    }
    if (readRetries() >= maxReadRetries) {
      return { ok: false, denial: denial('BUDGET_EXCEEDED', 'read retry budget is exhausted') };
    }
    if (!fits(reservedCostUnits, reservedProviderHttpRequests)) {
      return {
        ok: false,
        denial: denial('BUDGET_EXCEEDED', 'provider HTTP request budget is exhausted'),
      };
    }
    const waitUntil = monotonicTime() + retryAfterMs;
    if (waitUntil > finalReserveAtMs) {
      return {
        ok: false,
        denial: denial('FINAL_RESERVE', 'retry-after would consume the final response reserve'),
      };
    }
    incrementReadRetries();
    addCosts({
      ...request,
      costUnits: reservedCostUnits,
      providerHttpRequests: reservedProviderHttpRequests,
    });
    return { ok: true, delayMs: retryAfterMs };
  };
  return { operation: request.operation, release, retry };
};

export const consumeRuntimePendingRead = (
  input: PendingReadAccounting & {
    readonly callId: string;
    readonly removePending: (callId: string) => void;
    readonly readReservation: (
      request: RuntimeReadReservationRequest,
      releaseActive: () => void,
    ) => RuntimeReadReservation;
  },
): RuntimeBudgetResult<RuntimeReadReservation> => {
  const blocked = input.checkAdmission();
  if (blocked !== undefined) {
    input.removePending(input.callId);
    input.releaseActive();
    return { ok: false, denial: blocked };
  }
  const request = input.request;
  if (!input.fits(request.costUnits, request.providerHttpRequests)) {
    input.removePending(input.callId);
    input.releaseActive();
    return {
      ok: false,
      denial: denial('BUDGET_EXCEEDED', 'read cost budget is exhausted'),
    };
  }
  input.removePending(input.callId);
  input.addCosts(request);
  return {
    ok: true,
    value: input.readReservation(request, input.releaseActive),
  };
};
