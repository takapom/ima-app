import type { AssistantResponse } from '@ima/contracts';

export type ApiOperationInput = {
  readonly threadId: string;
  /** Initial search requests let the server derive the turn ID from the idempotency key. */
  readonly turnId: string | null;
  readonly baseRevision: number;
  readonly idempotencyKey: string;
};

export type ApiOperationToken = ApiOperationInput & {
  readonly generation: number;
  readonly expectedRevision: number;
  readonly attempt: number;
};

export type ApiResponseEnvelope = Pick<
  AssistantResponse,
  'threadId' | 'turnId' | 'responseId' | 'revision'
>;

export type ApiGateDecision =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason:
        | 'cancelled'
        | 'duplicate'
        | 'stale_generation'
        | 'stale_attempt'
        | 'stale_revision'
        | 'thread_mismatch'
        | 'turn_mismatch';
    };

export type ApiRequestGate = {
  readonly selectThread: (threadId: string, revision?: number) => void;
  readonly begin: (input: ApiOperationInput) => ApiOperationToken | null;
  readonly retry: (token: ApiOperationToken) => ApiOperationToken | null;
  readonly cancel: (token: ApiOperationToken) => void;
  readonly accept: (token: ApiOperationToken, response: ApiResponseEnvelope) => ApiGateDecision;
  readonly snapshot: () => {
    readonly threadId: string | null;
    readonly revision: number;
    readonly generation: number;
  };
};

const validRevision = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;

const validOperation = (input: ApiOperationInput): boolean =>
  input.threadId.length > 0 &&
  (input.turnId === null || input.turnId.length > 0) &&
  input.idempotencyKey.length > 0 &&
  validRevision(input.baseRevision);

/**
 * Owns request identity and apply eligibility until the state layer consumes it.
 * It has no network or UI dependency, so a late response cannot mutate state by itself.
 */
export const createApiRequestGate = (): ApiRequestGate => {
  let threadId: string | null = null;
  let revision = 0;
  let generation = 0;
  let nextAttempt = 0;
  const active = new Map<string, ApiOperationToken>();
  const cancelled = new Set<string>();
  const seenResponses = new Set<string>();

  const selectThread = (nextThreadId: string, nextRevision = 0): void => {
    if (
      nextThreadId.length === 0 ||
      !validRevision(nextRevision) ||
      (threadId === nextThreadId && nextRevision < revision)
    ) {
      return;
    }
    if (threadId === nextThreadId && nextRevision === revision) return;
    threadId = nextThreadId;
    revision = nextRevision;
    generation += 1;
    active.clear();
    cancelled.clear();
    seenResponses.clear();
  };

  const begin = (input: ApiOperationInput): ApiOperationToken | null => {
    if (!validOperation(input)) return null;
    if (threadId !== input.threadId) selectThread(input.threadId, input.baseRevision);
    if (threadId !== input.threadId || revision !== input.baseRevision) return null;
    const prior = active.get(input.idempotencyKey);
    if (prior !== undefined) {
      return prior.threadId === input.threadId &&
        prior.turnId === input.turnId &&
        prior.baseRevision === input.baseRevision
        ? prior
        : null;
    }
    if (cancelled.has(input.idempotencyKey)) return null;
    const token: ApiOperationToken = {
      ...input,
      generation,
      expectedRevision: input.baseRevision + 1,
      attempt: nextAttempt,
    };
    nextAttempt += 1;
    active.set(input.idempotencyKey, token);
    return token;
  };

  const retry = (token: ApiOperationToken): ApiOperationToken | null => {
    const current = active.get(token.idempotencyKey);
    if (
      current === undefined ||
      current.generation !== generation ||
      current.threadId !== threadId ||
      current.turnId !== token.turnId ||
      current.baseRevision !== token.baseRevision ||
      cancelled.has(token.idempotencyKey)
    ) {
      return null;
    }
    const next: ApiOperationToken = { ...current, attempt: nextAttempt };
    nextAttempt += 1;
    active.set(token.idempotencyKey, next);
    return next;
  };

  const cancel = (token: ApiOperationToken): void => {
    const current = active.get(token.idempotencyKey);
    if (
      current === undefined ||
      current.generation !== generation ||
      current.threadId !== threadId ||
      current.turnId !== token.turnId ||
      current.baseRevision !== token.baseRevision ||
      current.attempt !== token.attempt
    ) {
      return;
    }
    active.delete(token.idempotencyKey);
    cancelled.add(token.idempotencyKey);
  };

  const accept = (token: ApiOperationToken, response: ApiResponseEnvelope): ApiGateDecision => {
    if (seenResponses.has(response.responseId)) return { accepted: false, reason: 'duplicate' };
    const current = active.get(token.idempotencyKey);
    if (
      current === undefined ||
      current.generation !== generation ||
      current.generation !== token.generation ||
      current.threadId !== token.threadId ||
      current.turnId !== token.turnId ||
      current.baseRevision !== token.baseRevision
    ) {
      return {
        accepted: false,
        reason: cancelled.has(token.idempotencyKey) ? 'cancelled' : 'stale_generation',
      };
    }
    if (current.attempt !== token.attempt) {
      return { accepted: false, reason: 'stale_attempt' };
    }
    if (response.threadId !== threadId) return { accepted: false, reason: 'thread_mismatch' };
    if (token.turnId !== null && response.turnId !== token.turnId) {
      return { accepted: false, reason: 'turn_mismatch' };
    }
    if (response.revision < token.expectedRevision || response.revision <= revision) {
      return { accepted: false, reason: 'stale_revision' };
    }
    active.delete(token.idempotencyKey);
    seenResponses.add(response.responseId);
    revision = response.revision;
    return { accepted: true };
  };

  return {
    selectThread,
    begin,
    retry,
    cancel,
    accept,
    snapshot: () => ({ threadId, revision, generation }),
  };
};
