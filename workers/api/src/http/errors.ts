import * as v from 'valibot';
import { OpaqueIdSchema, PublicErrorSchema } from '@ima/contracts';
import type { PublicError } from '@ima/contracts';

type ErrorForStatus<Status extends PublicError['status']> = Extract<
  PublicError,
  { status: Status }
>;

export type BoundaryFailure = {
  [Status in PublicError['status']]: {
    readonly status: Status;
    readonly code: ErrorForStatus<Status>['code'];
  };
}[PublicError['status']];

/** Typed adapter failures cross the Worker boundary without exposing internal error text. */
export class HttpBoundaryError extends Error {
  readonly failure: BoundaryFailure;

  constructor(failure: BoundaryFailure) {
    super('HTTP boundary failure');
    this.name = 'HttpBoundaryError';
    this.failure = failure;
  }
}

const PUBLIC_MESSAGES: Record<PublicError['code'], string> = {
  INVALID_ARGUMENT: 'The request is invalid.',
  LOCATION_REQUIRED: 'A usable location is required.',
  LOCATION_IMPRECISE: 'A more precise location is required.',
  MISSING_CONTEXT: 'Required context is missing.',
  UNSUPPORTED_FIELD: 'The requested field is unavailable.',
  UNSUPPORTED_SCOPE: 'The requested scope is unavailable.',
  UNAUTHORIZED: 'Authentication is required.',
  FORBIDDEN: 'The operation is not allowed for this owner.',
  NOT_FOUND: 'The requested resource was not found.',
  UNKNOWN_CANDIDATE: 'The requested candidate was not found.',
  CONFLICT: 'The request conflicts with the current state.',
  SCHEMA_MISMATCH: 'The request schema is not supported.',
  STALE_TURN: 'The turn is stale.',
  CANCELLED: 'The operation was cancelled.',
  MIXED_TERMINAL_ACTION: 'The operation contains conflicting terminal actions.',
  EXPIRED: 'The requested resource has expired.',
  CURSOR_EXPIRED: 'The requested cursor has expired.',
  STALE_EVIDENCE: 'The requested evidence is stale.',
  PAYLOAD_TOO_LARGE: 'The request is too large.',
  RESULT_TOO_LARGE: 'The result is too large.',
  UNSUPPORTED_MEDIA_TYPE: 'The content type is not supported.',
  INVALID_EVIDENCE: 'The evidence is invalid.',
  MISSING_EVIDENCE: 'Required evidence is missing.',
  NOT_OPEN: 'The place is not open.',
  CONSTRAINT_VIOLATION: 'The request violates a constraint.',
  EXCLUDED_CANDIDATE: 'The candidate is excluded.',
  BUDGET_EXCEEDED: 'The operation budget was exceeded.',
  RATE_LIMITED: 'Too many requests.',
  INTERNAL: 'The server could not complete the request.',
  PROVIDER_UNAVAILABLE: 'The upstream service is unavailable.',
  SOURCE_CONFLICT: 'The upstream sources conflict.',
  TIMEOUT: 'The operation timed out.',
};

const FALLBACK_REQUEST_ID = 'request-generated';

const safeRequestId = (requestId: string): string => {
  const parsed = v.safeParse(OpaqueIdSchema, requestId);
  return parsed.success ? parsed.output : FALLBACK_REQUEST_ID;
};

/** Convert only the fixed public error vocabulary; internal details never enter the body. */
export const toPublicError = (requestId: string, failure: BoundaryFailure): PublicError => {
  const candidate = {
    schemaVersion: 'v1' as const,
    requestId: safeRequestId(requestId),
    status: failure.status,
    code: failure.code,
    message: PUBLIC_MESSAGES[failure.code],
  };
  const parsed = v.safeParse(PublicErrorSchema, candidate);
  if (parsed.success) return parsed.output;
  return {
    schemaVersion: 'v1',
    requestId: safeRequestId(requestId),
    status: 500,
    code: 'INTERNAL',
    message: PUBLIC_MESSAGES.INTERNAL,
  };
};

export const toErrorResponse = (requestId: string, failure: BoundaryFailure): Response => {
  const body = toPublicError(requestId, failure);
  return Response.json(body, {
    status: body.status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
};
