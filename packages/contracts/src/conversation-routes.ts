import * as v from 'valibot';
import { OpaqueIdSchema, RevisionSchema, Text } from '@contracts/common';
import {
  CreateConversationRequestSchema,
  ConversationResponseSchema,
  ConversationListResponseSchema,
  ConversationMessagesResponseSchema,
  ConversationTurnRequestSchema,
  ConversationRunResponseSchema,
  ConversationPhotoPathSchema,
  ConversationPhotoResponseSchema,
} from '@contracts/conversation-http';

const path = v.strictObject({ conversationId: OpaqueIdSchema });
const runPath = v.strictObject({ ...path.entries, runId: OpaqueIdSchema });
const limit = v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(100)));
export const ConversationHttpRouteContracts = {
  conversationPhoto: {
    method: 'GET',
    path: '/v1/conversations/:conversationId/messages/:sequence/photos/:candidateId',
    request: ConversationPhotoPathSchema,
    response: ConversationPhotoResponseSchema,
    successStatus: 200,
  },
  conversationCreate: {
    method: 'POST',
    path: '/v1/conversations',
    request: CreateConversationRequestSchema,
    response: ConversationResponseSchema,
    successStatus: 201,
  },
  conversationList: {
    method: 'GET',
    path: '/v1/conversations',
    request: v.strictObject({ limit, cursor: v.optional(Text(512)) }),
    response: ConversationListResponseSchema,
    successStatus: 200,
  },
  conversationRead: {
    method: 'GET',
    path: '/v1/conversations/:conversationId',
    request: path,
    response: ConversationResponseSchema,
    successStatus: 200,
  },
  conversationMessages: {
    method: 'GET',
    path: '/v1/conversations/:conversationId/messages',
    request: v.strictObject({
      path,
      query: v.strictObject({ limit, before: v.optional(RevisionSchema) }),
    }),
    response: ConversationMessagesResponseSchema,
    successStatus: 200,
  },
  conversationTurn: {
    method: 'POST',
    path: '/v1/conversations/:conversationId/turns',
    request: v.strictObject({ path, body: ConversationTurnRequestSchema }),
    response: ConversationRunResponseSchema,
    successStatus: 202,
  },
  conversationRun: {
    method: 'GET',
    path: '/v1/conversations/:conversationId/runs/:runId',
    request: runPath,
    response: ConversationRunResponseSchema,
    successStatus: 200,
  },
  // response validates each run event; the transport is text/event-stream, not a JSON body.
  conversationEvents: {
    method: 'GET',
    path: '/v1/conversations/:conversationId/runs/:runId/events',
    request: runPath,
    response: ConversationRunResponseSchema,
    successStatus: 200,
  },
  conversationCancel: {
    method: 'POST',
    path: '/v1/conversations/:conversationId/runs/:runId/cancel',
    request: v.strictObject({
      path: runPath,
      body: v.pick(CreateConversationRequestSchema, ['schemaVersion', 'requestId']),
    }),
    response: ConversationRunResponseSchema,
    successStatus: 200,
  },
  conversationDelete: {
    method: 'DELETE',
    path: '/v1/conversations/:conversationId',
    request: path,
    response: v.null(),
    successStatus: 204,
  },
} as const;
