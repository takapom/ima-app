import type { Context } from 'hono';
import * as v from 'valibot';
import { authenticateRequest } from '@worker/adapters/in/http/auth';
import { HttpBoundaryError, toErrorResponse } from '@worker/adapters/in/http/errors';
import type { MatchedRoute } from '@worker/adapters/in/http/http-route';
import { handleAuthorizedRoute } from '@worker/adapters/in/http/route-handler';
import type { HttpRouterConfig } from '@worker/adapters/in/http/router-config';

export type HttpEnv = {
  Bindings: { readonly config: HttpRouterConfig; readonly fallbackRequestId: string };
  Variables: { requestId: string };
};
export type HttpContext = Context<HttpEnv>;

export const notFoundResponse = (context: HttpContext): Response =>
  toErrorResponse(context.get('requestId'), { status: 404, code: 'NOT_FOUND' });
export const invalidRequest = (context: HttpContext): Response =>
  toErrorResponse(context.get('requestId'), { status: 400, code: 'INVALID_ARGUMENT' });

export const boundaryErrorResponse = (context: HttpContext, error: unknown): Response =>
  error instanceof HttpBoundaryError
    ? toErrorResponse(context.get('requestId'), error.failure, {
        retryAfterSeconds: error.retryAfterSeconds,
      })
    : toErrorResponse(context.get('requestId'), { status: 500, code: 'INTERNAL' });

export const parseRoutePath = <Schema extends v.GenericSchema>(
  schema: Schema,
  input: unknown,
): v.InferOutput<Schema> => {
  const parsed = v.safeParse(schema, input);
  if (!parsed.success) throw new HttpBoundaryError({ status: 400, code: 'INVALID_ARGUMENT' });
  return parsed.output;
};

/** Match and path/query validation precede authentication, rate limits and application work. */
export const publicRoute =
  (
    resolve: (context: HttpContext) => MatchedRoute,
  ): ((context: HttpContext) => Promise<Response>) =>
  async (context) => {
    // Hono dispatches HEAD through GET; HEAD is not part of the public API contract.
    if (context.req.method === 'HEAD') return notFoundResponse(context);
    // Hono tolerates malformed escapes in params; our boundary rejects them before authentication.
    try {
      decodeURIComponent(context.req.path);
    } catch {
      return invalidRequest(context);
    }
    const route = resolve(context);
    if (new URL(context.req.url).search.length > 0) return invalidRequest(context);
    const authenticated = await authenticateRequest(context.req.raw, context.env.config.auth);
    if (!authenticated.ok) return toErrorResponse(authenticated.requestId, authenticated.failure);
    context.set('requestId', authenticated.context.requestId);
    return handleAuthorizedRoute(context.req.raw, route, authenticated.context, context.env.config);
  };
