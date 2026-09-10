import * as v from 'valibot';
import {
  CalendarDateSchema,
  CandidateIdSchema,
  HttpsUrlSchema,
  IsoTimestampSchema,
  NullableText,
  OpaqueIdSchema,
  RevisionSchema,
  Text,
} from './common';
import { DisplayFieldSchema, PublicEvidenceTextSchema } from './public';

const PublicWarningSchema = v.strictObject({
  code: Text(80),
  message: Text(300),
});
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

export const WalkingRouteSchema = v.strictObject({
  originRef: OpaqueIdSchema,
  destinationCandidateId: CandidateIdSchema,
  originRevision: RevisionSchema,
  evaluatedAt: IsoTimestampSchema,
  durationSeconds: nonNegativeFiniteInteger,
  distanceMeters: nonNegativeFiniteNumber,
  warnings: v.array(PublicWarningSchema),
});
export type WalkingRoute = v.InferOutput<typeof WalkingRouteSchema>;

export const LastTrainTransferSchema = v.pipe(
  v.strictObject({
    fromStationRef: OpaqueIdSchema,
    toStationRef: OpaqueIdSchema,
    departureAt: IsoTimestampSchema,
    arrivalAt: IsoTimestampSchema,
  }),
  v.check(
    (transfer) => Date.parse(transfer.departureAt) <= Date.parse(transfer.arrivalAt),
    'train transfer must arrive at or after departure',
  ),
);

export const LastTrainInfoSchema = v.pipe(
  v.strictObject({
    serviceDate: CalendarDateSchema,
    fromStationRef: OpaqueIdSchema,
    homeStationRef: OpaqueIdSchema,
    journeyRef: OpaqueIdSchema,
    lastDepartureAt: IsoTimestampSchema,
    arrivesHomeAt: IsoTimestampSchema,
    transfers: v.array(LastTrainTransferSchema),
    placeToStationSeconds: nonNegativeFiniteInteger,
    arrivePlaceAt: IsoTimestampSchema,
    leaveBy: IsoTimestampSchema,
    availableStaySeconds: finiteInteger,
    minimumStayMinutes: v.pipe(finiteInteger, v.minValue(1), v.maxValue(180)),
    usable: v.boolean(),
  }),
  v.check(
    (info) => !info.usable || info.availableStaySeconds >= info.minimumStayMinutes * 60,
    'usable last train must satisfy minimum stay',
  ),
);
export type LastTrainInfo = v.InferOutput<typeof LastTrainInfoSchema>;

/** Facts rendered in a card or details screen; every fact carries its own evidence. */
const publicFieldEntries = {
  identity: v.optional(DisplayFieldSchema(PlaceIdentitySchema)),
  opening_hours: v.optional(DisplayFieldSchema(OpeningHoursSchema)),
  price: v.optional(DisplayFieldSchema(PriceInfoSchema)),
  photos: v.optional(DisplayFieldSchema(PhotoInfoSchema)),
  contact: v.optional(DisplayFieldSchema(ContactInfoSchema)),
  facilities: v.optional(DisplayFieldSchema(FacilitiesInfoSchema)),
  walking_route: v.optional(DisplayFieldSchema(WalkingRouteSchema)),
  last_train: v.optional(DisplayFieldSchema(LastTrainInfoSchema)),
};

export const PublicPlaceFieldsSchema = v.strictObject(publicFieldEntries);

export const PublicCardFieldsSchema = v.strictObject({
  ...publicFieldEntries,
  identity: DisplayFieldSchema(PlaceIdentitySchema),
});

export const PublicCardSchema = v.strictObject({
  candidateId: CandidateIdSchema,
  facts: PublicCardFieldsSchema,
  why: PublicEvidenceTextSchema(80),
  diff: v.optional(PublicEvidenceTextSchema(40)),
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
