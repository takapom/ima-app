import {
  conversationRoute,
  conversationFailure,
  positiveQuery,
} from '@worker/adapters/in/http/conversation-boundary';
import { conversationPhotoSources } from '@worker/runtime/conversations/conversation-photo-sources';
import { PhotoProviderError } from '@worker/runtime/ports/photo-media';
import { photoProviderFailure } from '@worker/adapters/in/http/photo-body-handler';
import { HttpBoundaryError, toErrorResponse } from '@worker/adapters/in/http/errors';
import { ConversationPhotoResponseSchema } from '@ima/contracts';
import * as v from 'valibot';

export const conversationPhotoRoute = conversationRoute([], async (context) => {
  const sequence = positiveQuery(
    context.http.req.param('sequence'),
    0,
    Number.MAX_SAFE_INTEGER - 1,
  );
  const scope = {
    ownerScopeRef: context.auth.ownerScopeRef,
    conversationId: context.http.req.param('conversationId') ?? '',
  };
  const read = () =>
    context.rpc.messages({ ...scope, now: context.now, beforeSequence: sequence + 1, limit: 1 });
  const page = await read();
  if (!page.ok) return conversationFailure(context.auth.requestId, page);
  const record = page.messages.find((entry) => entry.sequence === sequence);
  const candidateId = context.http.req.param('candidateId');
  const source = record?.message.parts
    .flatMap((part) => (part.kind === 'card_set' ? conversationPhotoSources(part) : []))
    .find((entry) => entry.candidateId === candidateId);
  if (source === undefined)
    return toErrorResponse(context.auth.requestId, { status: 404, code: 'NOT_FOUND' });
  const reader = context.http.env.config.conversationPhotos;
  if (reader === undefined)
    throw new HttpBoundaryError({ status: 502, code: 'PROVIDER_UNAVAILABLE' });
  try {
    const media = await reader.read(source.recordRef, context.http.req.raw.signal);
    if (media === null)
      return toErrorResponse(context.auth.requestId, { status: 404, code: 'NOT_FOUND' });
    // Deletion during external I/O must not publish a photo for a deleted conversation.
    const current = await context.rpc.read(scope).catch(async (error: unknown) => {
      await media.body.cancel();
      throw error;
    });
    if (!current.ok || context.http.req.raw.signal.aborted) {
      await media.body.cancel();
      return !current.ok
        ? conversationFailure(context.auth.requestId, current)
        : toErrorResponse(context.auth.requestId, { status: 409, code: 'CANCELLED' });
    }
    const descriptor = v.safeParse(ConversationPhotoResponseSchema, {
      bodyKind: 'binary',
      descriptor: {
        schemaVersion: 'v1',
        requestId: context.auth.requestId,
        contentType: media.contentType,
        expiresAt: new Date(Date.parse(context.now) + 30 * 60_000).toISOString(),
      },
    });
    if (!descriptor.success) {
      await media.body.cancel();
      throw new HttpBoundaryError({ status: 500, code: 'INTERNAL' });
    }
    return new Response(media.body, {
      headers: {
        'content-type': descriptor.output.descriptor.contentType,
        'cache-control': 'private, no-store',
        expires: new Date(descriptor.output.descriptor.expiresAt).toUTCString(),
        'x-ima-request-id': context.auth.requestId,
      },
    });
  } catch (error) {
    if (error instanceof PhotoProviderError) throw photoProviderFailure(error);
    throw error;
  }
});
