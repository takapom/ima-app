import * as v from 'valibot';
import {
  PrefsReadResponseSchema,
  PrefsWriteRequestSchema,
  PrefsWriteResponseSchema,
  SavedReferenceListResponseSchema,
} from '@ima/contracts';
import type { CancellationToken } from '@ima/core';
import type { AuthenticatedContext } from '@api/http/auth';
import { toErrorResponse } from '@api/http/errors';
import type {
  ApplicationHandler,
  ApplicationOperation,
  ApplicationResult,
  HandlerContext,
} from '@api/http/handler';
import { parseJsonBodyWithRaw } from '@api/http/input';
import type { MatchedRoute } from '@api/http/router-match';

export type OwnerHttpRoute = Extract<
  MatchedRoute,
  { readonly kind: 'prefs_read' | 'prefs_write' | 'saved_reference_list' }
>;

export type OwnerHttpRouteInput = {
  readonly route: OwnerHttpRoute;
  readonly request: Request;
  readonly auth: AuthenticatedContext;
  readonly application: ApplicationHandler;
  readonly serverNow: string;
  readonly maxBodyBytes: number;
};

const cancelled = (requestId: string): Response =>
  toErrorResponse(requestId, { status: 409, code: 'CANCELLED' });

const invalid = (requestId: string): Response =>
  toErrorResponse(requestId, { status: 400, code: 'INVALID_ARGUMENT' });

const internal = (requestId: string): Response =>
  toErrorResponse(requestId, { status: 500, code: 'INTERNAL' });

const jsonResponse = (body: unknown): Response =>
  Response.json(body, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });

const requestIdFromBody = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || !('requestId' in value)) return null;
  return typeof value.requestId === 'string' ? value.requestId : null;
};

const makeContext = (
  request: Request,
  auth: AuthenticatedContext,
  serverNow: string,
): HandlerContext => {
  const cancellation: CancellationToken = { isCancelled: () => request.signal.aborted };
  return { ...auth, serverNow, cancellation, signal: request.signal };
};

const parseBody = async <Schema extends v.GenericSchema>(
  request: Request,
  schema: Schema,
  maxBodyBytes: number,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly value: v.InferOutput<Schema> }
  | { readonly ok: false; readonly response: Response }
> => {
  const parsed = await parseJsonBodyWithRaw(request, schema, maxBodyBytes);
  if (!parsed.ok) return { ok: false, response: toErrorResponse(requestId, parsed.failure) };
  return requestIdFromBody(parsed.value) === requestId
    ? { ok: true, value: parsed.value }
    : { ok: false, response: invalid(requestId) };
};

const ensureOwnerResponse = async <Schema extends v.GenericSchema>(
  operation: ApplicationOperation,
  expectedKind: ApplicationResult['kind'],
  schema: Schema,
  requestId: string,
  context: HandlerContext,
  application: ApplicationHandler,
): Promise<Response> => {
  const result = await application.handle(operation, context);
  if (result.kind !== expectedKind) return internal(requestId);
  const parsed = v.safeParse(schema, result.response);
  if (!parsed.success) return internal(requestId);
  return requestIdFromBody(parsed.output) === requestId
    ? jsonResponse(parsed.output)
    : internal(requestId);
};

export const isOwnerHttpRoute = (route: MatchedRoute): route is OwnerHttpRoute =>
  route.kind === 'prefs_read' ||
  route.kind === 'prefs_write' ||
  route.kind === 'saved_reference_list';

/**
 * Handles authenticated owner prefs and saved-list routes. Thread ownership is not checked.
 */
export const handleOwnerHttpRoute = async (input: OwnerHttpRouteInput): Promise<Response> => {
  const requestId = input.auth.requestId;
  if (input.request.signal.aborted) return cancelled(requestId);
  const context = makeContext(input.request, input.auth, input.serverNow);
  if (input.route.kind === 'prefs_read') {
    return ensureOwnerResponse(
      { kind: 'prefs_read' },
      'prefs_read',
      PrefsReadResponseSchema,
      requestId,
      context,
      input.application,
    );
  }
  if (input.route.kind === 'saved_reference_list') {
    return ensureOwnerResponse(
      { kind: 'saved_reference_list' },
      'saved_reference_list',
      SavedReferenceListResponseSchema,
      requestId,
      context,
      input.application,
    );
  }
  const body = await parseBody(
    input.request,
    PrefsWriteRequestSchema,
    input.maxBodyBytes,
    requestId,
  );
  if (!body.ok) return body.response;
  if (input.request.signal.aborted) return cancelled(requestId);
  return ensureOwnerResponse(
    { kind: 'prefs_write', input: body.value },
    'prefs_write',
    PrefsWriteResponseSchema,
    requestId,
    context,
    input.application,
  );
};
