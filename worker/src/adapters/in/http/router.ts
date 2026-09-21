import { conversationRouter } from '@worker/adapters/in/http/conversation-router';
import { Hono } from 'hono';
import { REQUEST_ID_HEADER } from '@ima/contracts';
import { isValidRequestId } from '@worker/adapters/in/http/input';
import type { HttpRouterConfig } from '@worker/adapters/in/http/router-config';
import {
  boundaryErrorResponse,
  invalidRequest,
  notFoundResponse,
  type HttpContext,
  type HttpEnv,
} from '@worker/adapters/in/http/route-boundary';
import { threadRouter } from '@worker/adapters/in/http/thread-router';
import {
  attestRouter,
  eventsRouter,
  photoRouter,
  prefsRouter,
  savedRouter,
  searchRouter,
} from '@worker/adapters/in/http/resource-routers';

export { DEFAULT_JSON_BODY_LIMIT_BYTES } from '@worker/adapters/in/http/router-config';
export type {
  HttpRouterConfig,
  ResourceKind,
  ResourceReference,
  ResourceScopeAuthorizer,
  ResourceScopeDecision,
} from '@worker/adapters/in/http/router-config';

// Keep static segments literal; Hono decodes only captured parameters once.
const app = new Hono<HttpEnv>({
  strict: true,
  getPath: (request) => new URL(request.url).pathname,
});

app.use('*', async (context: HttpContext, next) => {
  context.set('requestId', context.env.fallbackRequestId);
  if (context.req.raw.headers.has('upgrade')) return notFoundResponse(context);
  try {
    await next();
    return context.res;
  } catch (error: unknown) {
    return boundaryErrorResponse(context, error);
  }
});
app.onError((error, context) => boundaryErrorResponse(context, error));
app.notFound(notFoundResponse);

app.route('/v1/threads', threadRouter);
app.route('/v1/conversations', conversationRouter);
app.route('/v1/prefs', prefsRouter);
app.route('/v1/saved', savedRouter);
app.route('/v1/photos', photoRouter);
app.route('/v1/attest', attestRouter);
app.route('/v1/search', searchRouter);
app.route('/v1/events', eventsRouter);

// An empty resource ID is invalid, while other trailing slashes remain unknown routes.
app.all('/v1/threads/', invalidRequest);
app.all('/v1/threads//*', invalidRequest);
app.get('/v1/photos/', (context) =>
  context.req.method === 'HEAD' ? notFoundResponse(context) : invalidRequest(context),
);
app.delete('/v1/saved/', invalidRequest);
app.get('/v1/saved//refresh', (context) =>
  context.req.method === 'HEAD' ? notFoundResponse(context) : invalidRequest(context),
);

const safeRequestId = (request: Request, config: HttpRouterConfig): string => {
  const supplied = request.headers.get(REQUEST_ID_HEADER);
  if (isValidRequestId(supplied)) return supplied;
  try {
    return config.auth.requestIdFactory();
  } catch {
    return 'request-generated';
  }
};

/** Each request gets its own bindings; the route table is shared, credentials and handlers are not. */
export const routeRequest = async (request: Request, config: HttpRouterConfig): Promise<Response> =>
  app.fetch(request, { config, fallbackRequestId: safeRequestId(request, config) });
