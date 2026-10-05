import * as v from 'valibot';
import {
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  SchemaVersionSchema,
  Text,
} from '@contracts/common';
import { PublicTextSchema } from '@contracts/public';
import { CardsDataSchema } from '@contracts/values';

export const PublicMessageSchema = PublicTextSchema(300);
export type PublicMessage = v.InferOutput<typeof PublicMessageSchema>;
export const PublicMessageListSchema = v.pipe(
  v.array(PublicMessageSchema),
  v.minLength(1),
  v.maxLength(4),
);

const responseMeta = {
  schemaVersion: SchemaVersionSchema,
  threadId: OpaqueIdSchema,
  turnId: OpaqueIdSchema,
  responseId: OpaqueIdSchema,
  revision: RevisionSchema,
  message: PublicMessageListSchema,
};

/** Set only when the turn searched and every search succeeded without a candidate. */
export const SearchOutcomeSchema = v.literal('no_candidates');
export type SearchOutcome = v.InferOutput<typeof SearchOutcomeSchema>;

export const AssistantMessageResponseSchema = v.strictObject({
  ...responseMeta,
  kind: v.literal('message'),
  presentation: v.literal('keep'),
  cardSetId: v.nullable(OpaqueIdSchema),
  searchOutcome: v.optional(SearchOutcomeSchema),
});
export type AssistantMessageResponse = v.InferOutput<typeof AssistantMessageResponseSchema>;

export const AssistantCardsResponseSchema = v.strictObject({
  ...responseMeta,
  kind: v.literal('cards'),
  presentation: v.literal('replace'),
  cardSetId: OpaqueIdSchema,
  cards: CardsDataSchema,
});
export type AssistantCardsResponse = v.InferOutput<typeof AssistantCardsResponseSchema>;

export const AssistantResponseSchema = v.variant('kind', [
  AssistantMessageResponseSchema,
  AssistantCardsResponseSchema,
]);
export type AssistantResponse = v.InferOutput<typeof AssistantResponseSchema>;

export const SearchResponseSchema = v.strictObject({
  requestId: OpaqueIdSchema,
  response: AssistantResponseSchema,
  warnings: v.array(
    v.strictObject({
      code: Text(80),
      message: Text(300),
    }),
  ),
});
export type SearchResponse = v.InferOutput<typeof SearchResponseSchema>;

export type ParseResult<T> =
  { success: true; data: T } | { success: false; issues: readonly string[] };

export const parseSearchResponse = (input: unknown): ParseResult<SearchResponse> => {
  const parsed = v.safeParse(SearchResponseSchema, input);
  return parsed.success
    ? { success: true, data: parsed.output }
    : { success: false, issues: parsed.issues.map((issue) => issue.message) };
};

/** JSON descriptor for a successful image response; the HTTP body is image bytes. */
export const PhotoResponseDescriptorSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: OpaqueIdSchema,
  token: Text(512),
  contentType: v.picklist(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  expiresAt: IsoTimestampSchema,
});
export const PhotoResponseSchema = PhotoResponseDescriptorSchema;
export type PhotoBinaryResponse = {
  descriptor: v.InferOutput<typeof PhotoResponseDescriptorSchema>;
  body: Uint8Array;
};
