import * as v from 'valibot';
import {
  AssistantResponseSchema,
  ThreadTurnRequestSchema,
  type AssistantResponse,
  type ThreadTurnRequest,
} from '@ima/contracts';

export type ThreadRuntimeTarget = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: number;
};

export type ThreadRuntimeTurnInput = ThreadRuntimeTarget & {
  readonly idempotencyKey: string;
  /** Validated Worker request; the DO creates the SDK user message from `text`. */
  readonly input: ThreadTurnRequest;
};

export type ThreadRuntimeRunStatus = 'completed' | 'cancelled' | 'failed' | 'stale';

export type ThreadRuntimeResponseReference = {
  readonly turnId: string;
  readonly responseId: string;
  readonly revision: number;
  readonly kind: AssistantResponse['kind'];
  readonly presentation: AssistantResponse['presentation'];
  readonly cardSetId: string | null;
  readonly restoreMode: 'reference_only';
};

export type ThreadRuntimeTurnResult = {
  readonly status: ThreadRuntimeRunStatus;
  readonly requestId: string | null;
  /** Initial completion may carry the already validated public DTO; replay never does. */
  readonly response: AssistantResponse | ThreadRuntimeResponseReference | null;
  readonly code?: ThreadRuntimeFailureCode;
};

export type ThreadRuntimeCancelStatus = 'accepted' | 'already_finished' | 'stale' | 'rejected';

export type ThreadRuntimeCancelResult = {
  readonly status: ThreadRuntimeCancelStatus;
  readonly code?: ThreadRuntimeFailureCode;
};

export type ThreadRuntimeResponseMetadata = {
  readonly turnId: string;
  readonly revision: number;
  readonly status: ThreadRuntimeRunStatus;
  readonly responseId: string | null;
  readonly kind: AssistantResponse['kind'] | null;
  readonly presentation: AssistantResponse['presentation'] | null;
  readonly cardSetId: string | null;
};

export type ThreadRuntimeReplayResult =
  | {
      readonly status: 'reference_only';
      readonly response: ThreadRuntimeResponseReference;
    }
  | { readonly status: 'unavailable'; readonly code: 'NOT_FOUND' | 'STALE_TURN' };

export type ThreadRuntimeFailureCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'TURN_ALREADY_ACTIVE'
  | 'CANCELLED'
  | 'STALE_TURN'
  | 'RUNTIME_UNCONFIGURED'
  | 'RUNTIME_FAILED';

export type ThreadRuntimeAdmission =
  | { readonly status: 'admitted'; readonly invalidate?: ThreadRuntimeTarget }
  | { readonly status: 'replay'; readonly result: ThreadRuntimeTurnResult }
  | { readonly status: 'rejected'; readonly result: ThreadRuntimeTurnResult };

const isNonEmptyText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;

const isPositiveRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export const isThreadRuntimeTarget = (value: unknown): value is ThreadRuntimeTarget => {
  if (typeof value !== 'object' || value === null) return false;
  if (!('ownerScopeRef' in value) || !('threadId' in value)) return false;
  if (!('turnId' in value) || !('revision' in value)) return false;
  return (
    isNonEmptyText(value.ownerScopeRef) &&
    isNonEmptyText(value.threadId) &&
    isNonEmptyText(value.turnId) &&
    isPositiveRevision(value.revision)
  );
};

export const isThreadRuntimeTurnInput = (value: unknown): value is ThreadRuntimeTurnInput => {
  if (!isThreadRuntimeTarget(value)) return false;
  if (!('idempotencyKey' in value) || !('input' in value)) return false;
  if (!isNonEmptyText(value.idempotencyKey)) return false;
  const parsed = v.safeParse(ThreadTurnRequestSchema, value.input);
  if (!parsed.success) return false;
  const request = parsed.output;
  return (
    request.idempotencyKey === value.idempotencyKey &&
    (request.turnId === null || request.turnId === value.turnId) &&
    request.revision === value.revision
  );
};

/** Hashes request content for idempotency without storing the request body in the DO ledger. */
export const runtimeInputDigest = async (input: ThreadTurnRequest): Promise<string> => {
  const parsed = v.safeParse(ThreadTurnRequestSchema, input);
  if (!parsed.success) throw new Error('runtime input is not validated');
  const { requestId, ...content } = parsed.output;
  void requestId;
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalJson(content)));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => canonicalJson(entry));
  if (typeof value !== 'object' || value === null) return value;
  const record: Record<string, unknown> = {};
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [key, entry] of entries) {
    record[key] = canonicalJson(entry);
  }
  return record;
};

export const runtimeFailure = (
  code: ThreadRuntimeFailureCode,
  requestId: string | null = null,
): ThreadRuntimeTurnResult => ({
  status: code === 'CANCELLED' ? 'cancelled' : code === 'STALE_TURN' ? 'stale' : 'failed',
  requestId,
  response: null,
  code,
});

export const cancelledRuntimeResult = (): ThreadRuntimeTurnResult => ({
  status: 'cancelled',
  requestId: null,
  response: null,
  code: 'CANCELLED',
});

export const responseReference = (
  value: unknown,
  target: Pick<ThreadRuntimeTarget, 'threadId' | 'turnId' | 'revision'>,
): ThreadRuntimeResponseReference | null => {
  if (target.revision >= Number.MAX_SAFE_INTEGER) return null;
  const parsed = v.safeParse(AssistantResponseSchema, value);
  if (!parsed.success) return null;
  const response = parsed.output;
  if (
    response.threadId !== target.threadId ||
    response.turnId !== target.turnId ||
    response.revision !== target.revision + 1
  ) {
    return null;
  }
  return {
    turnId: response.turnId,
    responseId: response.responseId,
    revision: response.revision,
    kind: response.kind,
    presentation: response.presentation,
    cardSetId: response.cardSetId,
    restoreMode: 'reference_only',
  };
};

export const responseMetadata = (
  value: unknown,
  target: Pick<ThreadRuntimeTarget, 'threadId' | 'turnId' | 'revision'>,
): Omit<ThreadRuntimeResponseMetadata, 'status'> | null => {
  const reference = responseReference(value, target);
  if (reference === null) return null;
  return {
    turnId: reference.turnId,
    revision: reference.revision,
    responseId: reference.responseId,
    kind: reference.kind,
    presentation: reference.presentation,
    cardSetId: reference.cardSetId,
  };
};
