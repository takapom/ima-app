import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type { HarnessContext } from '@worker/application/ports/context';
import type { ModelContextSource } from '@worker/application/model-context/model-context';
import type { ObservationContext } from '@worker/domain/evidence/freshness';
import type {
  RuntimeRetentionContext,
  RuntimeRetentionEphemeralToolResult,
} from '@worker/runtime/retention/runtime-retention';
import type { RuntimeBudget } from '@worker/runtime/budget/runtime-budget';
import {
  isRuntimeFinalMessageError,
  parseRuntimeFinalMessage,
  type RuntimeFinalMessage,
} from '@worker/runtime/turn-execution/runtime-final-message';
import { observeRuntimeTerminalFormatFailure } from '@worker/runtime/turn-execution/runtime-submit-diagnostic';
import type { RuntimeModelGuardAcceptance } from '@worker/runtime/turn-execution/runtime-model-guard';
import type { CommitPort, CommitRecord } from '@worker/application/ports/commit';
import type { CommittedResponse } from '@worker/application/use-cases/submit-response/submit-application';
import { prepareRuntimeConversationResponse } from '@worker/adapters/out/persistence/thread/durable-commit-adapter';
import { mapPreparedRuntimeResponse } from '@worker/runtime/response/runtime-public-response';
import type { RuntimePublicResponseDependencies } from '@worker/runtime/response/runtime-response';

export const prepareConversationCommit = (
  port: CommitPort,
  dependencies: RuntimePublicResponseDependencies | undefined,
  record: CommitRecord,
  response: CommittedResponse,
): void => {
  if (dependencies === undefined) return;
  prepareRuntimeConversationResponse(port, record, () =>
    mapPreparedRuntimeResponse(
      response,
      dependencies,
      {
        threadId: record.scope.threadId,
        turnId: record.turnId,
        responseId: record.responseId,
        revision: record.revision,
      },
      undefined,
    ),
  );
};

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

/**
 * Returns the final message only when the model's terminal text is usable. An empty terminal, or
 * one that is not the required envelope, commits nothing; failing the turn over it would also
 * discard the reads the turn already paid for. The turn instead ends without a commit, and the
 * boundary reports that situation. The reason is recorded because nothing else would show it.
 */
export const usableFinalMessage = (
  acceptance: Pick<RuntimeModelGuardAcceptance, 'finalText' | 'emptyFinal'>,
): RuntimeFinalMessage | undefined => {
  if (acceptance.emptyFinal || acceptance.finalText === null) {
    observeRuntimeTerminalFormatFailure('EMPTY_FINAL');
    return undefined;
  }
  try {
    return parseRuntimeFinalMessage(acceptance.finalText);
  } catch (error: unknown) {
    if (!isRuntimeFinalMessageError(error)) throw error;
    observeRuntimeTerminalFormatFailure(error.code);
    return undefined;
  }
};

/** A later successful retry clears that operation's failure; a missing search is not zero results. */
export const hasUnresolvedReadFailure = (
  results: Iterable<RuntimeRetentionEphemeralToolResult>,
): boolean => {
  const failed = new Map<string, boolean>();
  for (const { toolName, output: raw } of results) {
    if (toolName === 'submit_cards') continue;
    const output = isRecord(raw) && raw.type === 'json' ? raw.value : raw;
    failed.set(
      toolName,
      isRecord(output) &&
        output.status === 'error' &&
        isRecord(output.error) &&
        typeof output.error.code === 'string' &&
        [
          'INVALID_ARGUMENT',
          'MISSING_CONTEXT',
          'TIMEOUT',
          'RATE_LIMITED',
          'UPSTREAM_UNAVAILABLE',
          'BUDGET_EXCEEDED',
          'SCHEMA_MISMATCH',
        ].includes(output.error.code),
    );
  }
  return [...failed.values()].some(Boolean);
};

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

export const modelSource = (
  context: HarnessContext,
  source: Omit<ModelContextSource, 'harness'>,
  serverNow: string,
  budget: RuntimeBudget,
): ModelContextSource => ({
  harness: { ...context, serverNow, budget: currentBudget(budget) },
  userText: source.userText,
  history: source.history,
  cardSet: source.cardSet,
  evidence: source.evidence,
  savedReferences: source.savedReferences ?? [],
  ...(source.fieldPolicy === undefined ? {} : { fieldPolicy: source.fieldPolicy }),
});
