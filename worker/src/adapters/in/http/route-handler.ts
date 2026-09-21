import * as v from 'valibot';
import {
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  EmptyResponseSchema,
  EventsRequestSchema,
  LifecycleCommandSchema,
  LifecycleResponseSchema,
  SavedReferenceDeleteRequestSchema,
  SavedReferenceResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  ThreadReadResponseSchema,
  ThreadTurnRequestSchema,
  IsoTimestampSchema,
} from '@ima/contracts';
import {
  HttpBoundaryError,
  toErrorResponse,
  type BoundaryFailure,
} from '@worker/adapters/in/http/errors';
import type { AuthenticatedContext } from '@worker/adapters/in/http/auth';
import { parseJsonBodyWithRaw } from '@worker/adapters/in/http/input';
import type {
  ApplicationOperation,
  ApplicationResult,
  HandlerContext,
} from '@worker/adapters/in/http/handler';
import type { CancellationToken } from '@worker/application/ports/context';
import type { MatchedRoute } from '@worker/adapters/in/http/http-route';
import {
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  type HttpRouterConfig,
  type ResourceReference,
} from '@worker/adapters/in/http/router-config';
import { authorizeAppIntegrity } from '@worker/adapters/in/http/app-integrity-authorization';
import {
  handleAppIntegrityHttpRoute,
  isAppIntegrityHttpRoute,
} from '@worker/adapters/in/http/app-integrity-routes';
import { handleOwnerHttpRoute, isOwnerHttpRoute } from '@worker/adapters/in/http/owner-routes';
import {
  handleThreadPlaceWriteRoute,
  isThreadPlaceWriteRoute,
} from '@worker/adapters/in/http/thread-place-routes';
import { ensurePhotoResponse } from '@worker/adapters/in/http/photo-route';
import { rateLimitedResponse } from '@worker/adapters/in/http/rate-limit-response';

const invalidArgument = (): BoundaryFailure => ({ status: 400, code: 'INVALID_ARGUMENT' });
const internal = (): BoundaryFailure => ({ status: 500, code: 'INTERNAL' });
const cancelled = (): BoundaryFailure => ({ status: 409, code: 'CANCELLED' });
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
  signal?: AbortSignal,
): Promise<BoundaryFailure | null> => {
  const decision = await config.ownership.authorize({
    ownerScopeRef,
    resource,
    ...(signal === undefined ? {} : { signal }),
  });
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

const bodyFailure = <Schema extends v.GenericSchema>(
  request: Request,
  schema: Schema,
  maxBodyBytes: number,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly value: v.InferOutput<Schema>; readonly rawBody: Uint8Array }
  | { readonly ok: false; readonly response: Response }
> =>
  parseJsonBodyWithRaw(request, schema, maxBodyBytes).then((result) => {
    if (!result.ok) return { ok: false, response: toErrorResponse(requestId, result.failure) };
    const failure = bodyRequestIdFailure(result.value, requestId);
    return failure === null
      ? { ok: true, value: result.value, rawBody: result.rawBody }
      : { ok: false, response: toErrorResponse(requestId, failure) };
  });

const authorizedRate = async (
  route: MatchedRoute,
  auth: AuthenticatedContext,
  requestId: string,
  config: HttpRouterConfig,
): Promise<Response | null> => {
  const result = await config.handlers.rateLimiter.check({
    route: route.kind,
    deviceId: auth.deviceId,
    ownerScopeRef: auth.ownerScopeRef,
  });
  return result.allowed ? null : rateLimitedResponse(requestId, result.retryAfterSeconds);
};

export const handleAuthorizedRoute = async (
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
  if (isAppIntegrityHttpRoute(route)) {
    return handleAppIntegrityHttpRoute({
      route,
      request,
      auth,
      maxBodyBytes,
      gate: config.appIntegrity,
      serverNow: validatedServerNow(config),
    });
  }
  if (isOwnerHttpRoute(route)) {
    return handleOwnerHttpRoute({
      route,
      request,
      auth,
      serverNow,
      maxBodyBytes,
      application: config.handlers.application,
    });
  }
  const checkIntegrity = (rawBody?: Uint8Array): Promise<Response | null> =>
    authorizeAppIntegrity({
      gate: config.appIntegrity,
      request,
      route,
      auth,
      serverNow: validatedServerNow(config),
      maxBodyBytes,
      rawBody,
    });
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
    const integrityResponse = await checkIntegrity();
    if (integrityResponse !== null) return integrityResponse;
    return ensurePhotoResponse(route.path, requestId, photoContext, config.handlers.photo, () =>
      validatedServerNow(config),
    );
  }
  if (route.kind === 'saved_reference_refresh') {
    const failure = await checkResource(
      auth.ownerScopeRef,
      { kind: 'saved_reference', id: route.path.savedPlaceRef },
      config,
      request.signal,
    );
    if (failure !== null) return toErrorResponse(requestId, failure);
    const aborted = cancellationResponse(requestId, request);
    if (aborted !== null) return aborted;
    const integrityResponse = await checkIntegrity();
    if (integrityResponse !== null) return integrityResponse;
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
  if (route.kind === 'saved_reference_delete') {
    const body = await bodyFailure(
      request,
      SavedReferenceDeleteRequestSchema,
      maxBodyBytes,
      requestId,
    );
    if (!body.ok) return body.response;
    const aborted = cancellationResponse(requestId, request);
    if (aborted !== null) return aborted;
    const integrityResponse = await checkIntegrity(body.rawBody);
    if (integrityResponse !== null) return integrityResponse;
    return ensureApplicationResponse(
      { kind: 'saved_reference_delete', path: route.path, input: body.value },
      'saved_reference_delete',
      EmptyResponseSchema,
      204,
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
    const integrityResponse = await checkIntegrity(body.rawBody);
    if (integrityResponse !== null) return integrityResponse;
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
  if (isThreadPlaceWriteRoute(route)) {
    return handleThreadPlaceWriteRoute({
      route,
      request,
      auth,
      application: config.handlers.application,
      serverNow,
      maxBodyBytes,
      checkResource: (ownerScopeRef, threadId) =>
        checkResource(ownerScopeRef, { kind: 'thread', id: threadId }, config),
      checkIntegrity,
    });
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
    const integrityResponse = await checkIntegrity(body.rawBody);
    if (integrityResponse !== null) return integrityResponse;
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
