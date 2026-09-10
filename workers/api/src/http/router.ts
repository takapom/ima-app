import * as v from 'valibot';
import {
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  EmptyResponseSchema,
  EventsRequestSchema,
  LifecycleCommandSchema,
  LifecycleResponseSchema,
  PlaceResponseSchema,
  PhotoBinaryRouteResponseSchema,
  SavedReferenceResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  ThreadReadResponseSchema,
  ThreadTurnRequestSchema,
  IsoTimestampSchema,
  REQUEST_ID_HEADER,
} from '@ima/contracts';
import { HttpBoundaryError, toErrorResponse, toPublicError } from './errors';
import { authenticateRequest, type AuthConfig, type AuthenticatedContext } from './auth';
import { isValidRequestId, parseJsonBody } from './input';
import type {
  ApplicationOperation,
  ApplicationResult,
  HandlerContext,
  HandlerDependencies,
  PhotoPath,
} from './handler';
import type { BoundaryFailure } from './errors';
import type { CancellationToken } from '@ima/core';
import { matchRoute, type MatchedRoute } from './router-match';

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 32 * 1024;

export type ResourceKind = 'thread' | 'candidate' | 'saved_reference' | 'photo';

export type ResourceReference = {
  readonly kind: ResourceKind;
  readonly id: string;
};

export type ResourceScopeDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly failure: BoundaryFailure };

export interface ResourceScopeAuthorizer {
  authorize(input: {
    readonly ownerScopeRef: string;
    readonly resource: ResourceReference;
  }): Promise<ResourceScopeDecision>;
}

export type HttpRouterConfig = {
  readonly auth: AuthConfig;
  readonly handlers: HandlerDependencies;
  readonly ownership: ResourceScopeAuthorizer;
  readonly now: () => string;
  readonly maxBodyBytes?: number;
};

const notFound = (): BoundaryFailure => ({ status: 404, code: 'NOT_FOUND' });
const invalidArgument = (): BoundaryFailure => ({ status: 400, code: 'INVALID_ARGUMENT' });
const internal = (): BoundaryFailure => ({ status: 500, code: 'INTERNAL' });
const cancelled = (): BoundaryFailure => ({ status: 409, code: 'CANCELLED' });
const expired = (): BoundaryFailure => ({ status: 410, code: 'EXPIRED' });

const isHttpBoundaryError = (value: unknown): value is HttpBoundaryError =>
  value instanceof HttpBoundaryError;

const safeRequestId = (request: Request, config: HttpRouterConfig): string => {
  const supplied = request.headers.get(REQUEST_ID_HEADER);
  if (isValidRequestId(supplied)) return supplied;
  try {
    return config.auth.requestIdFactory();
  } catch {
    return 'request-generated';
  }
};

const routeKey = (route: MatchedRoute): string => route.kind;

const makeContext = (
  request: Request,
  auth: AuthenticatedContext,
  serverNow: string,
): HandlerContext => {
  const cancellation: CancellationToken = { isCancelled: () => request.signal.aborted };
  return { ...auth, serverNow, cancellation, signal: request.signal };
};

const validatedServerNow = (config: HttpRouterConfig): string => {
  const parsed = v.safeParse(IsoTimestampSchema, config.now());
  if (!parsed.success) throw new HttpBoundaryError(internal());
  return parsed.output;
};

const cancellationResponse = (requestId: string, request: Request): Response | null =>
  request.signal.aborted ? toErrorResponse(requestId, cancelled()) : null;

const checkResource = async (
  ownerScopeRef: string,
  resource: ResourceReference,
  config: HttpRouterConfig,
): Promise<BoundaryFailure | null> => {
  const decision = await config.ownership.authorize({ ownerScopeRef, resource });
  return decision.allowed ? null : decision.failure;
};

const requestIdFromBody = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || !('requestId' in value)) return null;
  const requestId = value.requestId;
  return typeof requestId === 'string' ? requestId : null;
};

const bodyRequestIdFailure = (value: unknown, requestId: string): BoundaryFailure | null => {
  const bodyRequestId = requestIdFromBody(value);
  return bodyRequestId === requestId ? null : invalidArgument();
};

const jsonResponse = (body: unknown, status: number): Response =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
  });

const retryAfter = (value: number | null): string =>
  value !== null && Number.isSafeInteger(value) && value >= 1 ? String(value) : '60';

const rateLimitedResponse = (requestId: string, seconds: number | null): Response => {
  const body = toPublicError(requestId, { status: 429, code: 'RATE_LIMITED' });
  return Response.json(body, {
    status: 429,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'retry-after': retryAfter(seconds),
    },
  });
};

const ensureApplicationResponse = async <Schema extends v.GenericSchema>(
  operation: ApplicationOperation,
  expectedKind: ApplicationResult['kind'],
  schema: Schema,
  status: number,
  requestId: string,
  context: HandlerContext,
  config: HttpRouterConfig,
): Promise<Response> => {
  const result = await config.handlers.application.handle(operation, context);
  if (result.kind !== expectedKind) return toErrorResponse(requestId, internal());
  const parsed = v.safeParse(schema, result.response);
  if (!parsed.success) return toErrorResponse(requestId, internal());
  if (status !== 204 && requestIdFromBody(parsed.output) !== requestId) {
    return toErrorResponse(requestId, internal());
  }
  return status === 204 ? new Response(null, { status: 204 }) : jsonResponse(parsed.output, status);
};

const ensurePhotoResponse = async (
  path: PhotoPath,
  requestId: string,
  context: HandlerContext,
  serverNow: string,
  config: HttpRouterConfig,
): Promise<Response> => {
  const result = await config.handlers.photo.read(path, context);
  const releaseBody = async (): Promise<void> => {
    if (!(result.body instanceof ReadableStream)) return;
    try {
      await result.body.cancel();
    } catch {
      // The public response is already invalid; cleanup cannot make it usable.
    }
  };
  const descriptor = {
    bodyKind: 'binary' as const,
    descriptor: result.descriptor,
  };
  const parsed = v.safeParse(PhotoBinaryRouteResponseSchema, descriptor);
  if (
    !parsed.success ||
    (!(result.body instanceof Uint8Array) && !(result.body instanceof ReadableStream)) ||
    parsed.output.descriptor.requestId !== requestId ||
    parsed.output.descriptor.token !== path.token
  ) {
    await releaseBody();
    return toErrorResponse(requestId, internal());
  }
  const currentServerNow = validatedServerNow(config);
  const now = Date.parse(currentServerNow);
  const expiresAt = Date.parse(parsed.output.descriptor.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt)) {
    await releaseBody();
    return toErrorResponse(requestId, internal());
  }
  if (expiresAt <= now) {
    await releaseBody();
    return toErrorResponse(requestId, expired());
  }
  const body =
    result.body instanceof Uint8Array
      ? (() => {
          const copy = new Uint8Array(result.body.byteLength);
          copy.set(result.body);
          return copy;
        })()
      : result.body;
  return new Response(body, {
    status: 200,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': parsed.output.descriptor.contentType,
      expires: new Date(expiresAt).toUTCString(),
      'x-ima-request-id': requestId,
    },
  });
};

const bodyFailure = <Schema extends v.GenericSchema>(
  request: Request,
  schema: Schema,
  maxBodyBytes: number,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly value: v.InferOutput<Schema> }
  | { readonly ok: false; readonly response: Response }
> =>
  parseJsonBody(request, schema, maxBodyBytes).then((result) => {
    if (!result.ok) return { ok: false, response: toErrorResponse(requestId, result.failure) };
    const failure = bodyRequestIdFailure(result.value, requestId);
    return failure === null
      ? { ok: true, value: result.value }
      : { ok: false, response: toErrorResponse(requestId, failure) };
  });

const authorizedRate = async (
  route: MatchedRoute,
  auth: AuthenticatedContext,
  requestId: string,
  config: HttpRouterConfig,
): Promise<Response | null> => {
  const result = await config.handlers.rateLimiter.check({
    route: routeKey(route),
    deviceId: auth.deviceId,
    ownerScopeRef: auth.ownerScopeRef,
  });
  return result.allowed ? null : rateLimitedResponse(requestId, result.retryAfterSeconds);
};

const routeAuthorized = async (
  request: Request,
  route: MatchedRoute,
  auth: AuthenticatedContext,
  config: HttpRouterConfig,
): Promise<Response> => {
  const requestId = auth.requestId;
  const cancelledResponse = cancellationResponse(requestId, request);
  if (cancelledResponse !== null) return cancelledResponse;
  const serverNow = validatedServerNow(config);
  const rateResponse = await authorizedRate(route, auth, requestId, config);
  if (rateResponse !== null) return rateResponse;
  const afterRateCancelled = cancellationResponse(requestId, request);
  if (afterRateCancelled !== null) return afterRateCancelled;
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES;

  if (route.kind === 'photos') {
    const photoContext = makeContext(request, auth, serverNow);
    if (config.handlers.photo.authorize !== undefined) {
      await config.handlers.photo.authorize(route.path, photoContext);
    } else {
      const failure = await checkResource(
        auth.ownerScopeRef,
        { kind: 'photo', id: route.path.token },
        config,
      );
      if (failure !== null) return toErrorResponse(requestId, failure);
    }
    const aborted = cancellationResponse(requestId, request);
    if (aborted !== null) return aborted;
    return ensurePhotoResponse(route.path, requestId, photoContext, serverNow, config);
  }
  if (route.kind === 'place') {
    const failure = await checkResource(
      auth.ownerScopeRef,
      { kind: 'candidate', id: route.path.candidateId },
      config,
    );
    if (failure !== null) return toErrorResponse(requestId, failure);
    const aborted = cancellationResponse(requestId, request);
    if (aborted !== null) return aborted;
    return ensureApplicationResponse(
      { kind: 'place', path: route.path, query: route.query },
      'place',
      PlaceResponseSchema,
      200,
      requestId,
      makeContext(request, auth, serverNow),
      config,
    );
  }
  if (route.kind === 'saved_reference_refresh') {
    const failure = await checkResource(
      auth.ownerScopeRef,
      { kind: 'saved_reference', id: route.path.savedPlaceRef },
      config,
    );
    if (failure !== null) return toErrorResponse(requestId, failure);
    const aborted = cancellationResponse(requestId, request);
    if (aborted !== null) return aborted;
    return ensureApplicationResponse(
      { kind: 'saved_reference_refresh', path: route.path },
      'saved_reference_refresh',
      SavedReferenceResponseSchema,
      200,
      requestId,
      makeContext(request, auth, serverNow),
      config,
    );
  }
  if (route.kind === 'events') {
    const body = await bodyFailure(request, EventsRequestSchema, maxBodyBytes, requestId);
    if (!body.ok) return body.response;
    const failure = await checkResource(
      auth.ownerScopeRef,
      { kind: 'thread', id: body.value.threadId },
      config,
    );
    if (failure !== null) return toErrorResponse(requestId, failure);
    const aborted = cancellationResponse(requestId, request);
    if (aborted !== null) return aborted;
    await config.handlers.events.accept(body.value, makeContext(request, auth, serverNow));
    return new Response(null, { status: 204 });
  }

  if (route.kind === 'create_thread') {
    const body = await bodyFailure(request, CreateThreadRequestSchema, maxBodyBytes, requestId);
    if (!body.ok) return body.response;
    const aborted = cancellationResponse(requestId, request);
    if (aborted !== null) return aborted;
    return ensureApplicationResponse(
      { kind: 'create_thread', input: body.value },
      'create_thread',
      CreateThreadResponseSchema,
      201,
      requestId,
      makeContext(request, auth, serverNow),
      config,
    );
  }

  if (route.kind === 'search') {
    const body = await bodyFailure(request, SearchRequestSchema, maxBodyBytes, requestId);
    if (!body.ok) return body.response;
    const bodyScopeFailure = await checkResource(
      auth.ownerScopeRef,
      { kind: 'thread', id: body.value.threadId },
      config,
    );
    if (bodyScopeFailure !== null) return toErrorResponse(requestId, bodyScopeFailure);
    const aborted = cancellationResponse(requestId, request);
    if (aborted !== null) return aborted;
    return ensureApplicationResponse(
      { kind: 'search', input: body.value },
      'search',
      SearchResponseSchema,
      200,
      requestId,
      makeContext(request, auth, serverNow),
      config,
    );
  }

  const threadFailure = await checkResource(
    auth.ownerScopeRef,
    { kind: 'thread', id: route.path.threadId },
    config,
  );
  if (threadFailure !== null) return toErrorResponse(requestId, threadFailure);
  const aborted = cancellationResponse(requestId, request);
  if (aborted !== null) return aborted;
  const context = makeContext(request, auth, serverNow);
  if (route.kind === 'read_thread') {
    return ensureApplicationResponse(
      { kind: 'read_thread', path: route.path },
      'read_thread',
      ThreadReadResponseSchema,
      200,
      requestId,
      context,
      config,
    );
  }
  if (route.kind === 'replay_thread') {
    return ensureApplicationResponse(
      { kind: 'replay_thread', path: route.path },
      'replay_thread',
      ThreadReadResponseSchema,
      200,
      requestId,
      context,
      config,
    );
  }
  if (route.kind === 'turn') {
    const body = await bodyFailure(request, ThreadTurnRequestSchema, maxBodyBytes, requestId);
    if (!body.ok) return body.response;
    const turnAborted = cancellationResponse(requestId, request);
    if (turnAborted !== null) return turnAborted;
    return ensureApplicationResponse(
      { kind: 'turn', path: route.path, input: body.value },
      'turn',
      SearchResponseSchema,
      200,
      requestId,
      context,
      config,
    );
  }
  if (route.kind === 'delete_thread') {
    const body = await bodyFailure(request, LifecycleCommandSchema, maxBodyBytes, requestId);
    if (!body.ok) return body.response;
    const deleteAborted = cancellationResponse(requestId, request);
    if (deleteAborted !== null) return deleteAborted;
    return ensureApplicationResponse(
      { kind: 'delete_thread', path: route.path, input: body.value },
      'delete_thread',
      EmptyResponseSchema,
      204,
      requestId,
      context,
      config,
    );
  }
  const body = await bodyFailure(request, LifecycleCommandSchema, maxBodyBytes, requestId);
  if (!body.ok) return body.response;
  const lifecycleAborted = cancellationResponse(requestId, request);
  if (lifecycleAborted !== null) return lifecycleAborted;
  return ensureApplicationResponse(
    { kind: 'lifecycle', action: route.action, path: route.path, input: body.value },
    'lifecycle',
    LifecycleResponseSchema,
    200,
    requestId,
    context,
    config,
  );
};

/** Public HTTP entry; unknown and SDK management surfaces never reach injected handlers. */
export const routeRequest = async (
  request: Request,
  config: HttpRouterConfig,
): Promise<Response> => {
  const fallbackRequestId = safeRequestId(request, config);
  let responseRequestId = fallbackRequestId;
  try {
    if (request.headers.get('upgrade') !== null) {
      return toErrorResponse(fallbackRequestId, notFound());
    }
    const matched = matchRoute(request);
    if (!matched.ok) return toErrorResponse(fallbackRequestId, matched.failure);
    const authenticated = await authenticateRequest(request, config.auth);
    if (!authenticated.ok) {
      return toErrorResponse(authenticated.requestId, authenticated.failure);
    }
    responseRequestId = authenticated.context.requestId;
    return await routeAuthorized(request, matched.route, authenticated.context, config);
  } catch (error: unknown) {
    if (isHttpBoundaryError(error)) {
      return toErrorResponse(responseRequestId, error.failure, {
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }
    return toErrorResponse(responseRequestId, internal());
  }
};
