import * as v from 'valibot';
import {
  HttpsUrlSchema,
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  Text,
} from '@worker/domain/primitives';
import { RetentionMetadataSchema } from '@worker/domain/evidence/retention';
import {
  PlaceIdentitySchema,
  OpeningHoursSchema,
  PriceInfoSchema,
  PhotoAttributionSchema,
  ContactInfoSchema,
  FacilitiesInfoSchema,
} from '@worker/domain/places/place-values';

const Attribution = v.strictObject({
  label: Text(160),
  sourceLink: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});
const Evidence = v.strictObject({
  evidenceId: OpaqueIdSchema,
  attribution: v.nullable(Attribution),
  attributions: v.optional(v.pipe(v.array(Attribution), v.minLength(1), v.maxLength(9))),
  retention: RetentionMetadataSchema,
});
const field = <T extends v.GenericSchema>(value: T) =>
  v.variant('status', [
    v.strictObject({
      status: v.literal('known'),
      value,
      evidence: v.pipe(v.array(Evidence), v.minLength(1)),
    }),
    v.strictObject({
      status: v.picklist(['unknown', 'unsupported', 'not_applicable']),
      reason: Text(300),
    }),
    v.strictObject({
      status: v.literal('error'),
      code: v.picklist(['PROVIDER_UNAVAILABLE', 'MISSING_EVIDENCE', 'INTERNAL']),
      reason: Text(300),
    }),
  ]);
const text = (max: number) =>
  v.strictObject({ text: Text(max), retention: RetentionMetadataSchema });
const Card = v.strictObject({
  candidateId: OpaqueIdSchema,
  facts: v.strictObject({
    identity: field(v.omit(PlaceIdentitySchema, ['listingText'])),
    opening_hours: v.optional(field(OpeningHoursSchema)),
    price: v.optional(field(PriceInfoSchema)),
    photos: v.optional(
      field(
        v.strictObject({
          photos: v.pipe(
            v.array(
              v.strictObject({
                photoToken: Text(512),
                attributions: v.array(PhotoAttributionSchema),
                sourceUrl: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
              }),
            ),
            v.maxLength(3),
          ),
          partialReason: v.optional(Text(300)),
        }),
      ),
    ),
    contact: v.optional(field(ContactInfoSchema)),
    facilities: v.optional(field(FacilitiesInfoSchema)),
  }),
  why: text(80),
  diff: v.optional(text(40)),
});
/** A historical display snapshot, never a candidate registry or authorization for a new turn. */
export const ConversationCardsSchema = v.strictObject({
  kind: v.literal('card_set'),
  threadId: OpaqueIdSchema,
  cardSetId: OpaqueIdSchema,
  revision: RevisionSchema,
  photosExpireAt: v.nullable(IsoTimestampSchema),
  cards: v.strictObject({ hero: Card, alts: v.pipe(v.array(Card), v.maxLength(2)) }),
});
export type ConversationCards = v.InferOutput<typeof ConversationCardsSchema>;
