import type {
  CandidateObservationRegistryPort,
  HarnessContext,
  ObservationContext,
} from '@ima/core';
import type { RuntimeRetentionContext } from '../runtime-retention';
import type { RuntimeBudget } from '../budget/runtime-budget';

export type RuntimeTurnCompositionErrorCode =
  'CONTEXT_MISMATCH' | 'RETENTION_MISMATCH' | 'FINAL_COMMIT_INVALID';

export class RuntimeTurnCompositionError extends Error {
  readonly code: RuntimeTurnCompositionErrorCode;

  constructor(code: RuntimeTurnCompositionErrorCode, message = code) {
    super(message);
    this.name = 'RuntimeTurnCompositionError';
    this.code = code;
  }
}

const earliest = (values: readonly (string | null)[]): string => {
  const present = values.filter((value): value is string => value !== null);
  const first = present[0];
  if (first === undefined) throw new RuntimeTurnCompositionError('RETENTION_MISMATCH');
  return present.reduce((current, value) =>
    Date.parse(value) < Date.parse(current) ? value : current,
  );
};

const ephemeralWindow = (
  context: RuntimeRetentionContext,
): { readonly localFreshUntil: string; readonly localExpiresAt: string } => {
  const localExpiresAt = earliest([
    context.retention.sessionExpiresAt,
    context.retention.deletionScheduledAt,
  ]);
  return {
    localFreshUntil: earliest([context.retention.freshUntil, localExpiresAt]),
    localExpiresAt,
  };
};

type ObservationExpiry = {
  readonly observationId: string;
  readonly candidateId: string;
  readonly field: string;
  readonly freshUntil: string | null;
  readonly expiresAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const findObservationExpiries = (value: unknown): ObservationExpiry[] => {
  if (Array.isArray(value)) return value.flatMap(findObservationExpiries);
  if (!isRecord(value)) return [];
  const own =
    typeof value.observationId === 'string' &&
    typeof value.candidateId === 'string' &&
    typeof value.field === 'string' &&
    (value.freshUntil === null || typeof value.freshUntil === 'string') &&
    typeof value.expiresAt === 'string'
      ? [
          {
            observationId: value.observationId,
            candidateId: value.candidateId,
            field: value.field,
            freshUntil: value.freshUntil,
            expiresAt: value.expiresAt,
          },
        ]
      : [];
  return [...own, ...Object.values(value).flatMap(findObservationExpiries)];
};

export const observedWindow = (
  output: unknown,
  context: RuntimeRetentionContext,
  registry: CandidateObservationRegistryPort,
): { readonly localFreshUntil: string; readonly localExpiresAt: string } => {
  const expiries = findObservationExpiries(output);
  if (expiries.length === 0) return ephemeralWindow(context);
  const scope = { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId };
  const freshUntil: (string | null)[] = [context.retention.freshUntil];
  const expiresAt: (string | null)[] = [
    context.retention.sessionExpiresAt,
    context.retention.deletionScheduledAt,
  ];
  for (const expiry of expiries) {
    const stored = registry.readObservation(scope, expiry.observationId);
    if (
      stored === undefined ||
      stored.candidateId !== expiry.candidateId ||
      stored.field !== expiry.field ||
      stored.context.ownerScopeRef !== context.ownerScopeRef ||
      stored.context.threadId !== context.threadId ||
      Date.parse(stored.expiresAt) !== Date.parse(expiry.expiresAt)
    ) {
      throw new RuntimeTurnCompositionError('RETENTION_MISMATCH');
    }
    freshUntil.push(expiry.freshUntil, stored.freshUntil, stored.retention.freshUntil);
    expiresAt.push(
      expiry.expiresAt,
      stored.expiresAt,
      stored.retention.sessionExpiresAt,
      stored.retention.deletionScheduledAt,
    );
  }
  const localExpiresAt = earliest(expiresAt);
  return { localFreshUntil: earliest([...freshUntil, localExpiresAt]), localExpiresAt };
};

export const observationResultIsReusable = (
  output: unknown,
  context: RuntimeRetentionContext,
  registry: CandidateObservationRegistryPort,
  expectedContext: ObservationContext,
): boolean => {
  const expiries = findObservationExpiries(output);
  const scope = { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId };
  return expiries.every((expiry) => {
    const reuse = registry.evaluateObservationReuse({
      scope,
      candidateId: expiry.candidateId,
      field: expiry.field,
      context: expectedContext,
      observationId: expiry.observationId,
    });
    return reuse.status === 'reusable' && reuse.observation.observationId === expiry.observationId;
  });
};

export const currentBudget = (budget: RuntimeBudget): HarnessContext['budget'] => {
  const snapshot = budget.snapshot();
  return {
    wallClockMs: budget.limits.wholeTurnMs,
    finalReserveMs: budget.limits.finalReserveMs,
    modelCallsRemaining: Math.max(0, budget.limits.maxModelSteps - snapshot.modelSteps),
    readCallsRemaining: Math.max(0, budget.limits.maxReadCalls - snapshot.readCalls),
    providerHttpRequestsRemaining: Math.max(
      0,
      budget.limits.maxProviderHttpRequests - snapshot.providerHttpRequests,
    ),
    retriesRemaining: Math.max(0, budget.limits.maxReadRetries - snapshot.readRetries),
  };
};
