import { Hono } from 'hono';
import { publicConversationMessage } from '@worker/runtime/conversations/conversation-photo-sources';
import { conversationPhotoRoute } from '@worker/adapters/in/http/conversation-photo-route';
import { streamSSE } from 'hono/streaming';
import * as v from 'valibot';
import {
  ConversationListResponseSchema,
  ConversationMessagesResponseSchema,
  ConversationResponseSchema,
  ConversationRunResponseSchema,
  ConversationTurnRequestSchema,
  CreateConversationRequestSchema,
  IsoTimestampSchema,
  OpaqueIdSchema,
} from '@ima/contracts';
import {
  conversationRoute,
  conversationBody,
  conversationFailure,
  conversationJson,
  positiveQuery,
  type ConversationHttpContext,
} from '@worker/adapters/in/http/conversation-boundary';
import type { HttpEnv } from '@worker/adapters/in/http/route-boundary';
import { HttpBoundaryError } from '@worker/adapters/in/http/errors';
import { conversationFingerprint } from '@worker/adapters/out/security/conversation-fingerprint';
import type { Conversation } from '@worker/domain/conversations/conversation';
import type { ConversationRunResult } from '@worker/application/ports/conversation-runs';

export const conversationRouter = new Hono<HttpEnv>();
conversationRouter.get(
  '/:conversationId/messages/:sequence/photos/:candidateId',
  conversationPhotoRoute,
);
const publicConversation = ({ ownerScopeRef: _owner, ...conversation }: Conversation) =>
  conversation;
const scopeFor = (context: ConversationHttpContext) => ({
  ownerScopeRef: context.auth.ownerScopeRef,
  conversationId: context.http.req.param('conversationId') ?? '',
});
const envelope = (context: ConversationHttpContext) => ({
  schemaVersion: 'v1' as const,
  requestId: context.auth.requestId,
});
const cursorSchema = v.strictObject({
  updatedAt: IsoTimestampSchema,
  conversationId: OpaqueIdSchema,
});
const cursor = (value: string | undefined) => {
  if (value === undefined) return null;
  try {
    if (value.length > 512) throw new Error('invalid');
    return v.parse(cursorSchema, JSON.parse(atob(value)));
  } catch {
    throw new HttpBoundaryError({ status: 400, code: 'INVALID_ARGUMENT' });
  }
};
const runBody = (
  context: ConversationHttpContext,
  result: Extract<ConversationRunResult, { ok: true }>,
  response: unknown = null,
) => ({
  ...envelope(context),
  conversation: publicConversation(result.conversation),
  run: result.run,
  response,
});

conversationRouter.post(
  '/',
  conversationRoute([], async (context) => {
    const body = await conversationBody(context, CreateConversationRequestSchema, false);
    if (!body.ok) return body.response;
    const id = `conversation-${await conversationFingerprint([context.auth.ownerScopeRef, body.value.idempotencyKey])}`;
    const result = await context.rpc.create({
      ownerScopeRef: context.auth.ownerScopeRef,
      conversationId: id,
      now: context.now,
      idempotencyKey: body.value.idempotencyKey,
    });
    return !result.ok
      ? conversationFailure(context.auth.requestId, result)
      : conversationJson(
          context,
          ConversationResponseSchema,
          {
            ...envelope(context),
            conversation: publicConversation(result.conversation),
            activeRun: null,
          },
          201,
        );
  }),
);
conversationRouter.get(
  '/',
  conversationRoute(['limit', 'cursor'], async (context) => {
    const result = await context.rpc.list({
      ownerScopeRef: context.auth.ownerScopeRef,
      limit: positiveQuery(context.http.req.query('limit'), 30, 100),
      before: cursor(context.http.req.query('cursor')),
    });
    return !result.ok
      ? conversationFailure(context.auth.requestId, result)
      : conversationJson(context, ConversationListResponseSchema, {
          ...envelope(context),
          conversations: result.conversations.map(publicConversation),
          nextCursor: result.nextCursor === null ? null : btoa(JSON.stringify(result.nextCursor)),
        });
  }),
);
conversationRouter.get(
  '/:conversationId',
  conversationRoute([], async (context) => {
    const scope = scopeFor(context);
    const result = await context.rpc.read(scope);
    return !result.ok
      ? conversationFailure(context.auth.requestId, result)
      : conversationJson(context, ConversationResponseSchema, {
          ...envelope(context),
          conversation: publicConversation(result.conversation),
          activeRun: await context.rpc.activeRun(scope),
        });
  }),
);
conversationRouter.get(
  '/:conversationId/messages',
  conversationRoute(['limit', 'before'], async (context) => {
    const result = await context.rpc.messages({
      ...scopeFor(context),
      now: context.now,
      limit: positiveQuery(context.http.req.query('limit'), 50, 100),
      beforeSequence:
        context.http.req.query('before') === undefined
          ? null
          : positiveQuery(context.http.req.query('before'), 1, Number.MAX_SAFE_INTEGER),
    });
    return !result.ok
      ? conversationFailure(context.auth.requestId, result)
      : conversationJson(context, ConversationMessagesResponseSchema, {
          ...envelope(context),
          messages: result.messages.map(publicConversationMessage),
          nextBeforeSequence: result.nextBeforeSequence,
        });
  }),
);
conversationRouter.post(
  '/:conversationId/turns',
  conversationRoute([], async (context) => {
    const body = await conversationBody(context, ConversationTurnRequestSchema, true);
    if (!body.ok) return body.response;
    const result = await context.rpc.submit({
      ...scopeFor(context),
      deviceId: context.auth.deviceId,
      request: body.value,
    });
    return !result.ok
      ? conversationFailure(context.auth.requestId, result)
      : conversationJson(context, ConversationRunResponseSchema, runBody(context, result), 202);
  }),
);
conversationRouter.get(
  '/:conversationId/runs/:runId',
  conversationRoute([], async (context) => {
    const result = await context.rpc.getRun({
      ...scopeFor(context),
      runId: context.http.req.param('runId') ?? '',
    });
    return !result.ok
      ? conversationFailure(context.auth.requestId, result)
      : conversationJson(
          context,
          ConversationRunResponseSchema,
          runBody(context, result, result.response ?? null),
        );
  }),
);
conversationRouter.get(
  '/:conversationId/runs/:runId/events',
  conversationRoute([], async (context) => {
    const scope = { ...scopeFor(context), runId: context.http.req.param('runId') ?? '' };
    const initial = await context.rpc.getRun(scope);
    if (!initial.ok) return conversationFailure(context.auth.requestId, initial);
    context.http.header('Content-Encoding', 'Identity');
    return streamSSE(
      context.http,
      async (stream) => {
        let result = initial;
        for (let count = 0; count < 90 && !stream.aborted; count++) {
          if (count > 0) {
            const next = await context.rpc.getRun(scope);
            if (!next.ok) {
              await stream.writeSSE({
                event: 'unavailable',
                data: JSON.stringify({
                  code: next.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL',
                }),
              });
              return;
            }
            result = next;
          }
          const data = v.parse(
            ConversationRunResponseSchema,
            runBody(context, result, result.response ?? null),
          );
          await stream.writeSSE({
            event: 'run',
            id: `${result.run.runId}:${result.run.status}`,
            data: JSON.stringify(data),
          });
          if (result.run.status !== 'accepted' && result.run.status !== 'running') return;
          await stream.sleep(1_000);
        }
      },
      async (_error, stream) => {
        await stream.writeSSE({ event: 'unavailable', data: JSON.stringify({ code: 'INTERNAL' }) });
      },
    );
  }),
);
conversationRouter.delete(
  '/:conversationId',
  conversationRoute([], async (context) => {
    const result = await context.rpc.remove(scopeFor(context));
    return !result.ok
      ? conversationFailure(context.auth.requestId, result)
      : new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  }),
);

conversationRouter.post(
  '/:conversationId/runs/:runId/cancel',
  conversationRoute([], async (context) => {
    const body = await conversationBody(
      context,
      v.pick(CreateConversationRequestSchema, ['schemaVersion', 'requestId']),
      false,
    );
    if (!body.ok) return body.response;
    const result = await context.rpc.cancelRun({
      ...scopeFor(context),
      runId: context.http.req.param('runId') ?? '',
    });
    return !result.ok
      ? conversationFailure(context.auth.requestId, result)
      : conversationJson(context, ConversationRunResponseSchema, runBody(context, result));
  }),
);
