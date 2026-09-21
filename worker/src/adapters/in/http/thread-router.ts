import { Hono } from 'hono';
import { ThreadPathSchema } from '@ima/contracts';
import {
  notFoundResponse,
  parseRoutePath,
  publicRoute,
  type HttpContext,
  type HttpEnv,
} from '@worker/adapters/in/http/route-boundary';

const threadPath = (context: HttpContext) =>
  parseRoutePath(ThreadPathSchema, { threadId: context.req.param('threadId') });

export const threadRouter = new Hono<HttpEnv>();

threadRouter.post(
  '/',
  publicRoute(() => ({ kind: 'create_thread' })),
);
// Preserve validation of a thread ID even for unsupported methods and suffixes.
threadRouter.use('/:threadId', async (context: HttpContext, next) => {
  threadPath(context);
  await next();
});
threadRouter.use('/:threadId/*', async (context: HttpContext, next) => {
  threadPath(context);
  await next();
});
threadRouter.get(
  '/:threadId',
  publicRoute((context) => ({ kind: 'read_thread', path: threadPath(context) })),
);
threadRouter.get(
  '/:threadId/replay',
  publicRoute((context) => ({ kind: 'replay_thread', path: threadPath(context) })),
);
threadRouter.post(
  '/:threadId/turns',
  publicRoute((context) => ({ kind: 'turn', path: threadPath(context) })),
);
threadRouter.post(
  '/:threadId/saved',
  publicRoute((context) => ({ kind: 'saved_reference_create', path: threadPath(context) })),
);
threadRouter.post(
  '/:threadId/decided',
  publicRoute((context) => ({ kind: 'place_decide', path: threadPath(context) })),
);
threadRouter.delete(
  '/:threadId',
  publicRoute((context) => ({ kind: 'delete_thread', path: threadPath(context) })),
);
threadRouter.post(
  '/:threadId/cancel',
  publicRoute((context) => ({ kind: 'lifecycle', action: 'cancel', path: threadPath(context) })),
);
threadRouter.post(
  '/:threadId/resume',
  publicRoute((context) => ({ kind: 'lifecycle', action: 'resume', path: threadPath(context) })),
);
threadRouter.post(
  '/:threadId/restart',
  publicRoute((context) => ({ kind: 'lifecycle', action: 'restart', path: threadPath(context) })),
);
threadRouter.post(
  '/:threadId/end',
  publicRoute((context) => ({ kind: 'lifecycle', action: 'end', path: threadPath(context) })),
);
threadRouter.all('/:threadId', notFoundResponse);
threadRouter.all('/:threadId/*', notFoundResponse);
