import * as v from 'valibot';
import {
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  SchemaVersionSchema,
  Text,
} from './common';
import { PublicEvidenceTextSchema } from './public';
import { CardsDataSchema } from './values';

export const PublicMessageSchema = PublicEvidenceTextSchema(300);
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

export const AssistantMessageResponseSchema = v.strictObject({
  ...responseMeta,
  kind: v.literal('message'),
  presentation: v.literal('keep'),
  cardSetId: v.nullable(OpaqueIdSchema),
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

/** JSON descriptor for a successful image response; the HTTP body is image bytes. */
export const PhotoResponseDescriptorSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: OpaqueIdSchema,
  token: Text(512),
  contentType: v.picklist(['image/jpeg', 'image/png', 'image/webp']),
  expiresAt: IsoTimestampSchema,
});
export const PhotoResponseSchema = PhotoResponseDescriptorSchema;
export type PhotoBinaryResponse = {
  descriptor: v.InferOutput<typeof PhotoResponseDescriptorSchema>;
  body: Uint8Array;
};
