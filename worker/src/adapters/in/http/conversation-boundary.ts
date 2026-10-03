import * as v from 'valibot';
import { IsoTimestampSchema, OpaqueIdSchema } from '@ima/contracts';
import { authenticateRequest, type AuthenticatedContext } from '@worker/adapters/in/http/auth';
import { HttpBoundaryError, toErrorResponse } from '@worker/adapters/in/http/errors';
import {
  invalidRequest,
  notFoundResponse,
  type HttpContext,
} from '@worker/adapters/in/http/route-boundary';
import { DEFAULT_JSON_BODY_LIMIT_BYTES } from '@worker/adapters/in/http/router-config';
import { parseJsonBodyWithRaw } from '@worker/adapters/in/http/input';
import { authorizeAppIntegrity } from '@worker/adapters/in/http/app-integrity-authorization';
import { rateLimitedResponse } from '@worker/adapters/in/http/rate-limit-response';
import {
  conversationOwnerName,
  type ConversationApiRpc,
} from '@worker/adapters/out/persistence/conversations/durable-conversation-store';
import type { ConversationStoreFailure } from '@worker/application/ports/conversation-store';

export type ConversationHttpContext = {
  readonly http: HttpContext;
  readonly auth: AuthenticatedContext;
  readonly now: string;
  readonly rpc: ConversationApiRpc;
};
export const conversationRoute =
  (queries: readonly string[], handle: (context: ConversationHttpContext) => Promise<Response>) =>
  async (http: HttpContext): Promise<Response> => {
    if (http.req.method === 'HEAD') return notFoundResponse(http);
    try {
      decodeURIComponent(http.req.path);
    } catch {
      return invalidRequest(http);
    }
    for (const key of ['conversationId', 'runId', 'candidateId']) {
      const value = http.req.param(key);
      if (value !== undefined && !v.safeParse(OpaqueIdSchema, value).success)
        return invalidRequest(http);
    }
    const params = new URL(http.req.url).searchParams;
    let invalidQuery = false;
    params.forEach((_value, key) => {
      if (!queries.includes(key) || params.getAll(key).length !== 1) invalidQuery = true;
    });
    if (invalidQuery) return invalidRequest(http);
    const config = http.env.config;
    const auth = await authenticateRequest(http.req.raw, config.auth);
    if (!auth.ok) return toErrorResponse(auth.requestId, auth.failure);
    http.set('requestId', auth.context.requestId);
    const now = v.safeParse(IsoTimestampSchema, config.now());
    if (!now.success || config.conversations === undefined)
      throw new HttpBoundaryError({ status: 500, code: 'INTERNAL' });
    const limiter =
      http.req.param('candidateId') !== undefined
        ? (config.conversationPhotosRateLimiter ?? config.handlers.rateLimiter)
        : http.req.method === 'GET'
          ? (config.conversationReadsRateLimiter ?? config.handlers.rateLimiter)
          : config.handlers.rateLimiter;
    const rate = await limiter.check({
      route: 'conversation',
      ownerScopeRef: auth.context.ownerScopeRef,
      deviceId: auth.context.deviceId,
    });
    if (!rate.allowed) return rateLimitedResponse(auth.context.requestId, rate.retryAfterSeconds);
    if (http.req.raw.signal.aborted)
      return toErrorResponse(auth.context.requestId, { status: 409, code: 'CANCELLED' });
    http.header('Cache-Control', 'no-store');
    return handle({
      http,
      auth: auth.context,
      now: now.output,
      rpc: config.conversations.getByName(conversationOwnerName(auth.context.ownerScopeRef)),
    });
  };

export const conversationBody = async <Schema extends v.GenericSchema>(
  context: ConversationHttpContext,
  schema: Schema,
  generates: boolean,
) => {
  const config = context.http.env.config;
  const maxBytes = config.maxBodyBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES;
  const parsed = await parseJsonBodyWithRaw(context.http.req.raw, schema, maxBytes);
  if (!parsed.ok) throw new HttpBoundaryError(parsed.failure);
  const value: unknown = parsed.value;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('requestId' in value) ||
    value.requestId !== context.auth.requestId
  )
    throw new HttpBoundaryError({ status: 400, code: 'INVALID_ARGUMENT' });
  if (generates) {
    const rejected = await authorizeAppIntegrity({
      gate: config.appIntegrity,
      request: context.http.req.raw,
      route: { kind: 'conversation_turn' },
      auth: context.auth,
      serverNow: context.now,
      maxBodyBytes: maxBytes,
      rawBody: parsed.rawBody,
    });
    if (rejected !== null) return { ok: false as const, response: rejected };
  }
  return { ok: true as const, value: parsed.value };
};

export const conversationFailure = (
  requestId: string,
  failure: ConversationStoreFailure,
): Response =>
  toErrorResponse(
    requestId,
    failure.code === 'NOT_FOUND'
      ? { status: 404, code: 'NOT_FOUND' }
      : failure.code === 'INVALID_INPUT'
        ? { status: 400, code: 'INVALID_ARGUMENT' }
        : { status: 409, code: 'CONFLICT' },
  );
export const conversationJson = <Schema extends v.GenericSchema>(
  context: ConversationHttpContext,
  schema: Schema,
  body: unknown,
  status = 200,
): Response => {
  const parsed = v.safeParse(schema, body);
  if (!parsed.success) throw new HttpBoundaryError({ status: 500, code: 'INTERNAL' });
  return Response.json(parsed.output, { status, headers: { 'cache-control': 'no-store' } });
};
export const positiveQuery = (value: string | undefined, fallback: number, max: number): number => {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max)
    throw new HttpBoundaryError({ status: 400, code: 'INVALID_ARGUMENT' });
  return Number(value);
};
