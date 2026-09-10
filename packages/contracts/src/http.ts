import * as v from 'valibot';
import {
  DetailFieldSchema,
  IsoTimestampSchema,
  OpaqueIdSchema,
  RequestIdSchema,
  RevisionSchema,
  SchemaVersionSchema,
  Text,
} from './common';
import {
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  EventsRequestSchema,
  SearchRequestSchema,
  ThreadTurnRequestSchema,
} from './preferences';
import { PublicErrorSchema } from './errors';
import type { PublicError } from './errors';
import { PublicCandidateRefSchema } from './public';
import { PublicPlaceDetailsDataSchema } from './values';
import {
  AssistantCardsResponseSchema,
  AssistantMessageResponseSchema,
  PhotoResponseDescriptorSchema,
  SearchResponseSchema,
} from './response';
import type { AssistantCardsResponse, AssistantMessageResponse, ParseResult } from './response';
import type { CreateThreadResponse } from './preferences';
import type { CreateThreadRequest, SearchRequest, ThreadTurnRequest } from './preferences';
import type { RetentionMetadata } from './public';

export const APP_TOKEN_HEADER = 'X-App-Token' as const;
export const DEVICE_ID_HEADER = 'X-Device-Id' as const;
export const OWNER_CREDENTIAL_HEADER = 'X-Ima-Owner-Credential' as const;
export const REQUEST_ID_HEADER = 'X-Ima-Request-Id' as const;
export const APP_VERSION_HEADER = 'X-App-Version' as const;
export const OWNER_CREDENTIAL_BYTES = 32 as const;
export const OWNER_CREDENTIAL_BASE64URL_LENGTH = 43 as const;

export const OwnerCredentialHeaderSchema = v.pipe(
  v.string(),
  v.length(OWNER_CREDENTIAL_BASE64URL_LENGTH),
  // 32 bytes encode to 42 full base64url chars plus a final 4-bit char.
  v.regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
);

export const RequestHeadersSchema = v.strictObject({
  appToken: Text(256),
  deviceId: OpaqueIdSchema,
  ownerCredential: OwnerCredentialHeaderSchema,
  requestId: RequestIdSchema,
  appVersion: Text(64),
});
export type RequestHeaders = v.InferOutput<typeof RequestHeadersSchema>;

export const LifecycleCommandSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  turnId: v.nullable(OpaqueIdSchema),
  revision: RevisionSchema,
  idempotencyKey: OpaqueIdSchema,
});
export type LifecycleCommand = v.InferOutput<typeof LifecycleCommandSchema>;

export const PhotoPathSchema = v.strictObject({
  token: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});

export const PlacePathSchema = v.strictObject({
  candidateId: OpaqueIdSchema,
});

export const PlaceQuerySchema = v.strictObject({
  fields: v.pipe(
    v.array(DetailFieldSchema),
    v.minLength(1),
    v.maxLength(8),
    v.check((fields) => new Set(fields).size === fields.length, 'duplicate field'),
  ),
});

export const SavedReferencePathSchema = v.strictObject({
  savedPlaceRef: OpaqueIdSchema,
});

export const ThreadPathSchema = v.strictObject({
  threadId: OpaqueIdSchema,
});

export const LifecycleRouteRequestSchema = v.strictObject({
  path: ThreadPathSchema,
  body: LifecycleCommandSchema,
});

const threadMessageMeta = v.omit(AssistantMessageResponseSchema, ['schemaVersion', 'threadId']);
const threadCardsMeta = v.omit(AssistantCardsResponseSchema, ['schemaVersion', 'threadId']);

const canRestoreFull = (retention: RetentionMetadata) =>
  retention.retentionDecision === 'allow' && retention.restoreMode === 'full';

const canRestoreText = (text: AssistantMessageResponse['message'][number]) =>
  canRestoreFull(text.retention) &&
  text.evidence.every((evidence) => canRestoreFull(evidence.retention));

type CardFact =
  AssistantCardsResponse['cards']['hero']['facts'][keyof AssistantCardsResponse['cards']['hero']['facts']];

const canRestoreCardFact = (fact: CardFact | undefined) =>
  fact === undefined ||
  fact.status !== 'known' ||
  fact.evidence.every((evidence) => canRestoreFull(evidence.retention));

const canRestoreCards = (cards: AssistantCardsResponse['cards']) =>
  Object.values(cards.hero.facts).every(canRestoreCardFact) &&
  cards.alts.every((card) => Object.values(card.facts).every(canRestoreCardFact)) &&
  canRestoreText(cards.hero.why) &&
  (cards.hero.diff === undefined || canRestoreText(cards.hero.diff)) &&
  cards.alts.every(
    (card) => canRestoreText(card.why) && (card.diff === undefined || canRestoreText(card.diff)),
  );

const ThreadMessageRecordSchema = v.pipe(
  v.strictObject({
    ...threadMessageMeta.entries,
    restoreMode: v.literal('full'),
  }),
  v.check(
    (record) => record.message.every(canRestoreText),
    'full thread message requires fully restorable retention metadata',
  ),
);
const ThreadCardsRecordSchema = v.pipe(
  v.strictObject({
    ...threadCardsMeta.entries,
    restoreMode: v.literal('full'),
  }),
  v.check(
    (record) => record.message.every(canRestoreText) && canRestoreCards(record.cards),
    'full thread cards require fully restorable retention metadata',
  ),
);
const ThreadMessageRestoredRecordSchema = v.strictObject({
  ...v.omit(threadMessageMeta, ['message']).entries,
  restoreMode: v.picklist(['reference_only', 'unavailable']),
});
const ThreadCardsRestoredRecordSchema = v.strictObject({
  ...v.omit(threadCardsMeta, ['message', 'cards']).entries,
  restoreMode: v.picklist(['reference_only', 'unavailable']),
});
export const ThreadResponseRecordSchema = v.union([
  ThreadMessageRecordSchema,
  ThreadCardsRecordSchema,
  ThreadMessageRestoredRecordSchema,
  ThreadCardsRestoredRecordSchema,
]);
export type ThreadResponseRecord = v.InferOutput<typeof ThreadResponseRecordSchema>;

export const ThreadReadResponseSchema = v.pipe(
  v.strictObject({
    schemaVersion: SchemaVersionSchema,
    requestId: RequestIdSchema,
    threadId: OpaqueIdSchema,
    revision: RevisionSchema,
    active: v.boolean(),
    responses: v.array(ThreadResponseRecordSchema),
  }),
  v.check((snapshot) => {
    const responseIds = snapshot.responses.map((response) => response.responseId);
    const revisions = snapshot.responses.map((response) => response.revision);
    return (
      new Set(responseIds).size === responseIds.length &&
      new Set(revisions).size === revisions.length &&
      snapshot.responses.every((response) => response.revision <= snapshot.revision)
    );
  }, 'thread records must have unique IDs and revisions and be no newer than the snapshot'),
);
export type ThreadReadResponse = v.InferOutput<typeof ThreadReadResponseSchema>;

export const parseThreadSnapshot = (input: unknown): ParseResult<ThreadReadResponse> => {
  const parsed = v.safeParse(ThreadReadResponseSchema, input);
  return parsed.success
    ? { success: true, data: parsed.output }
    : { success: false, issues: parsed.issues.map((issue) => issue.message) };
};

export const LifecycleResponseSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  threadId: OpaqueIdSchema,
  turnId: v.nullable(OpaqueIdSchema),
  revision: RevisionSchema,
  state: v.picklist(['active', 'cancelled', 'ended', 'restarted', 'resumed']),
});

export const EmptyResponseSchema = v.null();

export const PlaceResponseSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  threadId: OpaqueIdSchema,
  revision: RevisionSchema,
  data: PublicPlaceDetailsDataSchema,
});

export const SavedReferenceResponseSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  savedPlaceRef: OpaqueIdSchema,
  candidate: PublicCandidateRefSchema,
  data: PublicPlaceDetailsDataSchema,
});

export const EventsAcceptedResponseSchema = v.null();

export const ErrorResponseSchema = PublicErrorSchema;

const parseSchema = <Schema extends v.GenericSchema>(
  schema: Schema,
  input: unknown,
): ParseResult<v.InferOutput<Schema>> => {
  const parsed = v.safeParse(schema, input);
  return parsed.success
    ? { success: true, data: parsed.output }
    : { success: false, issues: parsed.issues.map((issue) => issue.message) };
};

/** Runtime validation entry points for mobile services; schemas stay owned by contracts. */
export const parseRequestHeaders = (input: unknown): ParseResult<RequestHeaders> =>
  parseSchema(RequestHeadersSchema, input);

export const parseSearchRequest = (input: unknown): ParseResult<SearchRequest> =>
  parseSchema(SearchRequestSchema, input);

export const parseThreadTurnRequest = (input: unknown): ParseResult<ThreadTurnRequest> =>
  parseSchema(ThreadTurnRequestSchema, input);

export const parseCreateThreadRequest = (input: unknown): ParseResult<CreateThreadRequest> =>
  parseSchema(CreateThreadRequestSchema, input);

export const parsePublicError = (input: unknown): ParseResult<PublicError> =>
  parseSchema(PublicErrorSchema, input);

export const parseCreateThreadResponse = (input: unknown): ParseResult<CreateThreadResponse> =>
  parseSchema(CreateThreadResponseSchema, input);

export const parseLifecycleResponse = (
  input: unknown,
): ParseResult<v.InferOutput<typeof LifecycleResponseSchema>> =>
  parseSchema(LifecycleResponseSchema, input);

export const parseLifecycleCommand = (input: unknown): ParseResult<LifecycleCommand> =>
  parseSchema(LifecycleCommandSchema, input);

export const parseThreadPath = (
  input: unknown,
): ParseResult<v.InferOutput<typeof ThreadPathSchema>> => parseSchema(ThreadPathSchema, input);

/** Adapter result for a photo route: metadata is validated, while the HTTP body is bytes. */
export const PhotoBinaryRouteResponseSchema = v.strictObject({
  bodyKind: v.literal('binary'),
  descriptor: PhotoResponseDescriptorSchema,
});

export const RouteContracts = {
  search: {
    method: 'POST',
    path: '/v1/search',
    request: SearchRequestSchema,
    response: SearchResponseSchema,
    successStatus: 200,
  },
  photos: {
    method: 'GET',
    path: '/v1/photos/:token',
    request: PhotoPathSchema,
    response: PhotoBinaryRouteResponseSchema,
    successStatus: 200,
  },
  place: {
    method: 'GET',
    path: '/v1/places/:candidateId',
    request: v.strictObject({ path: PlacePathSchema, query: PlaceQuerySchema }),
    response: PlaceResponseSchema,
    successStatus: 200,
  },
  savedReferenceRefresh: {
    method: 'GET',
    path: '/v1/saved/:savedPlaceRef/refresh',
    request: SavedReferencePathSchema,
    response: SavedReferenceResponseSchema,
    successStatus: 200,
  },
  events: {
    method: 'POST',
    path: '/v1/events',
    request: EventsRequestSchema,
    response: EventsAcceptedResponseSchema,
    successStatus: 204,
  },
  createThread: {
    method: 'POST',
    path: '/v1/threads',
    request: CreateThreadRequestSchema,
    response: CreateThreadResponseSchema,
    successStatus: 201,
  },
  turn: {
    method: 'POST',
    path: '/v1/threads/:threadId/turns',
    request: v.strictObject({ path: ThreadPathSchema, body: ThreadTurnRequestSchema }),
    response: SearchResponseSchema,
    successStatus: 200,
  },
  readThread: {
    method: 'GET',
    path: '/v1/threads/:threadId',
    request: ThreadPathSchema,
    response: ThreadReadResponseSchema,
    successStatus: 200,
  },
  replayThread: {
    method: 'GET',
    path: '/v1/threads/:threadId/replay',
    request: ThreadPathSchema,
    response: ThreadReadResponseSchema,
    successStatus: 200,
  },
  cancel: {
    method: 'POST',
    path: '/v1/threads/:threadId/cancel',
    request: LifecycleRouteRequestSchema,
    response: LifecycleResponseSchema,
    successStatus: 200,
  },
  resume: {
    method: 'POST',
    path: '/v1/threads/:threadId/resume',
    request: LifecycleRouteRequestSchema,
    response: LifecycleResponseSchema,
    successStatus: 200,
  },
  restart: {
    method: 'POST',
    path: '/v1/threads/:threadId/restart',
    request: LifecycleRouteRequestSchema,
    response: LifecycleResponseSchema,
    successStatus: 200,
  },
  end: {
    method: 'POST',
    path: '/v1/threads/:threadId/end',
    request: LifecycleRouteRequestSchema,
    response: LifecycleResponseSchema,
    successStatus: 200,
  },
  deleteThread: {
    method: 'DELETE',
    path: '/v1/threads/:threadId',
    request: LifecycleRouteRequestSchema,
    response: EmptyResponseSchema,
    successStatus: 204,
  },
} as const;

export const RequestMetaSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  receivedAt: IsoTimestampSchema,
});
