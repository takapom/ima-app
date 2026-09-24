import * as v from 'valibot';
import {
  CandidateIdSchema,
  HttpsUrlSchema,
  IsoTimestampSchema,
  NullableText,
  Text,
} from '@contracts/common';
import { DisplayFieldSchema, PublicTextSchema } from '@contracts/public';

const HttpsLink = (maxLength: number) => v.pipe(HttpsUrlSchema, v.maxLength(maxLength));
const finiteNumber = v.pipe(
  v.number(),
  v.check((value) => Number.isFinite(value), 'number must be finite'),
);
const finiteInteger = v.pipe(
  finiteNumber,
  v.integer(),
  v.check((value) => Number.isSafeInteger(value), 'integer must be safe'),
);
const nonNegativeFiniteInteger = v.pipe(finiteInteger, v.minValue(0));
const nonNegativeFiniteNumber = v.pipe(finiteNumber, v.minValue(0));

export const PlaceIdentitySchema = v.strictObject({
  name: Text(160),
  area: Text(160),
  address: NullableText(500),
  category: NullableText(120),
  /** Listed nearest station and route text. Null means the Provider supplied neither. */
  stationName: v.nullable(Text(160)),
  accessText: v.nullable(Text(500)),
  businessStatus: v.picklist([
    'operational',
    'temporarily_closed',
    'permanently_closed',
    'unknown',
  ]),
  sourceUrl: v.nullable(HttpsLink(2048)),
});
export type PlaceIdentity = v.InferOutput<typeof PlaceIdentitySchema>;

/** `endAt: null` means the provider supplied an open-ended interval (for example 24/7). */
export const OpeningIntervalSchema = v.pipe(
  v.strictObject({
    startAt: IsoTimestampSchema,
    endAt: v.nullable(IsoTimestampSchema),
  }),
  v.check(
    (interval) =>
      interval.endAt === null || Date.parse(interval.startAt) <= Date.parse(interval.endAt),
    'opening interval must end at or after it starts',
  ),
);

export const OpeningHoursSchema = v.strictObject({
  timeZone: Text(64),
  intervals: v.array(OpeningIntervalSchema),
  weeklyText: v.array(Text(300)),
  evaluatedAt: IsoTimestampSchema,
  listedOpenAtEvaluation: v.nullable(v.boolean()),
  nextBoundaryAt: v.nullable(IsoTimestampSchema),
  lastOrderAt: v.nullable(IsoTimestampSchema),
  lastOrderRaw: v.nullable(Text(160)),
});
export type OpeningHours = v.InferOutput<typeof OpeningHoursSchema>;

export const PriceRangeSchema = v.pipe(
  v.strictObject({
    currency: Text(16),
    min: nonNegativeFiniteNumber,
    max: nonNegativeFiniteNumber,
    unit: v.picklist(['per_person', 'per_item', 'unknown']),
  }),
  v.check((range) => range.min <= range.max, 'price range min must not exceed max'),
);

export const PriceInfoSchema = v.strictObject({
  level: v.nullable(nonNegativeFiniteInteger),
  range: v.nullable(PriceRangeSchema),
  rawLabel: v.nullable(Text(160)),
});
export type PriceInfo = v.InferOutput<typeof PriceInfoSchema>;

export const AttributionItemSchema = v.strictObject({
  displayName: Text(160),
  uri: v.nullable(HttpsLink(2048)),
});

export const PhotoSchema = v.strictObject({
  photoToken: Text(512),
  attributions: v.array(AttributionItemSchema),
  sourceUrl: v.nullable(HttpsLink(2048)),
});

export const PhotoInfoSchema = v.strictObject({
  photos: v.pipe(v.array(PhotoSchema), v.maxLength(3)),
  /** Present when the provider supplied photos but one or more server handles were withheld. */
  partialReason: v.optional(Text(300)),
});
export type PhotoInfo = v.InferOutput<typeof PhotoInfoSchema>;

export const ContactInfoSchema = v.strictObject({
  websiteUrl: v.nullable(HttpsLink(2048)),
  phone: v.nullable(Text(64)),
  mapUrl: v.nullable(HttpsLink(2048)),
});
export type ContactInfo = v.InferOutput<typeof ContactInfoSchema>;

export const FacilityValueSchema = v.picklist(['yes', 'no', 'partial', 'unknown']);
export const FacilitiesInfoSchema = v.strictObject({
  wifi: FacilityValueSchema,
  nonSmoking: FacilityValueSchema,
  privateRoom: FacilityValueSchema,
  parking: FacilityValueSchema,
  sourceText: v.array(Text(300)),
});
export type FacilitiesInfo = v.InferOutput<typeof FacilitiesInfoSchema>;

/** Facts rendered in a card or details screen; every fact carries its own evidence. */
const publicFieldEntries = {
  identity: v.optional(DisplayFieldSchema(PlaceIdentitySchema)),
  opening_hours: v.optional(DisplayFieldSchema(OpeningHoursSchema)),
  price: v.optional(DisplayFieldSchema(PriceInfoSchema)),
  photos: v.optional(DisplayFieldSchema(PhotoInfoSchema)),
  contact: v.optional(DisplayFieldSchema(ContactInfoSchema)),
  facilities: v.optional(DisplayFieldSchema(FacilitiesInfoSchema)),
};

export const PublicPlaceFieldsSchema = v.strictObject(publicFieldEntries);

export const PublicCardFieldsSchema = v.strictObject({
  ...publicFieldEntries,
  identity: DisplayFieldSchema(PlaceIdentitySchema),
});

export const PublicCardSchema = v.strictObject({
  candidateId: CandidateIdSchema,
  facts: PublicCardFieldsSchema,
  why: PublicTextSchema(80),
  diff: v.optional(PublicTextSchema(40)),
});
export type PublicCard = v.InferOutput<typeof PublicCardSchema>;

export const PublicCardsSchema = v.pipe(
  v.strictObject({
    hero: PublicCardSchema,
    alts: v.pipe(v.array(PublicCardSchema), v.maxLength(2)),
  }),
  v.check(
    (cards) =>
      new Set([cards.hero.candidateId, ...cards.alts.map((alt) => alt.candidateId)]).size ===
      cards.alts.length + 1,
    'hero and alts must contain unique candidates',
  ),
  v.check(
    (cards) => cards.alts.every((alt) => alt.diff !== undefined),
    'alternative cards require diff evidence',
  ),
);
export type PublicCards = v.InferOutput<typeof PublicCardsSchema>;

export const PublicPlaceDetailsDataSchema = v.strictObject({
  items: v.pipe(
    v.array(
      v.strictObject({
        candidateId: CandidateIdSchema,
        fields: PublicPlaceFieldsSchema,
      }),
    ),
    v.minLength(1),
    v.maxLength(5),
    v.check(
      (items) => new Set(items.map((item) => item.candidateId)).size === items.length,
      'details items must contain unique candidates',
    ),
  ),
});
export type PublicPlaceDetailsData = v.InferOutput<typeof PublicPlaceDetailsDataSchema>;

/** Public renderer DTO; Core's selection/submit tool output is a separate schema. */
export const CardsDataSchema = PublicCardsSchema;
export type CardsData = v.InferOutput<typeof CardsDataSchema>;
