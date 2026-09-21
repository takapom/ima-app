import { Hono } from 'hono';
import { PhotoPathSchema, SavedReferencePathSchema } from '@ima/contracts';
import {
  invalidRequest,
  parseRoutePath,
  publicRoute,
  type HttpContext,
  type HttpEnv,
} from '@worker/adapters/in/http/route-boundary';

export const prefsRouter = new Hono<HttpEnv>();
prefsRouter.get(
  '/',
  publicRoute(() => ({ kind: 'prefs_read' })),
);
prefsRouter.put(
  '/',
  publicRoute(() => ({ kind: 'prefs_write' })),
);

const savedPath = (context: HttpContext) =>
  parseRoutePath(SavedReferencePathSchema, { savedPlaceRef: context.req.param('savedPlaceRef') });
export const savedRouter = new Hono<HttpEnv>();
savedRouter.get(
  '/',
  publicRoute(() => ({ kind: 'saved_reference_list' })),
);
savedRouter.get(
  '/:savedPlaceRef/refresh',
  publicRoute((context) => ({ kind: 'saved_reference_refresh', path: savedPath(context) })),
);
savedRouter.delete(
  '/:savedPlaceRef',
  publicRoute((context) => ({ kind: 'saved_reference_delete', path: savedPath(context) })),
);

export const photoRouter = new Hono<HttpEnv>();
photoRouter.get(
  '/:token',
  publicRoute((context) => ({
    kind: 'photos',
    path: parseRoutePath(PhotoPathSchema, { token: context.req.param('token') }),
  })),
);

export const attestRouter = new Hono<HttpEnv>();
attestRouter.get('/nonce', (context) =>
  context.req.method === 'HEAD'
    ? invalidRequest(context)
    : publicRoute(() => ({ kind: 'attest_nonce' }))(context),
);
attestRouter.post(
  '/enroll',
  publicRoute(() => ({ kind: 'attest_enroll' })),
);
attestRouter.post(
  '/revoke',
  publicRoute(() => ({ kind: 'attest_revoke' })),
);
attestRouter.all('/nonce', invalidRequest);
attestRouter.all('/enroll', invalidRequest);
attestRouter.all('/revoke', invalidRequest);

export const searchRouter = new Hono<HttpEnv>();
searchRouter.post(
  '/',
  publicRoute(() => ({ kind: 'search' })),
);

export const eventsRouter = new Hono<HttpEnv>();
eventsRouter.post(
  '/',
  publicRoute(() => ({ kind: 'events' })),
);
