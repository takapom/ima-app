import * as v from 'valibot';
import {
  CandidateIdSchema,
  CalendarDateSchema,
  HttpsUrlSchema,
  IsoTimestampSchema,
  NonNegativeFiniteNumberSchema,
  NonNegativeSafeIntegerSchema,
  OpaqueIdSchema,
  RevisionSchema,
  SafeIntegerSchema,
  Text,
} from '@core/domain/primitives';

export const PlaceIdentitySchema = v.strictObject({
  name: Text(160),
  area: Text(160),
  address: v.nullable(v.pipe(v.string(), v.maxLength(500))),
  category: v.nullable(v.pipe(v.string(), v.maxLength(120))),
  businessStatus: v.picklist([
    'operational',
    'temporarily_closed',
    'permanently_closed',
    'unknown',
  ]),
  sourceUrl: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});
export type PlaceIdentity = v.InferOutput<typeof PlaceIdentitySchema>;

/** `endAt: null` means the provider supplied an open-ended interval (for example 24/7). */
export const OpeningIntervalSchema = v.pipe(
  v.strictObject({ startAt: IsoTimestampSchema, endAt: v.nullable(IsoTimestampSchema) }),
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
  lastOrderRaw: v.nullable(v.pipe(v.string(), v.maxLength(160))),
});
export type OpeningHours = v.InferOutput<typeof OpeningHoursSchema>;

export const PriceRangeSchema = v.pipe(
  v.strictObject({
    currency: Text(16),
    min: NonNegativeFiniteNumberSchema,
    max: NonNegativeFiniteNumberSchema,
    unit: v.picklist(['per_person', 'per_item', 'unknown']),
  }),
  v.check((range) => range.min <= range.max, 'price range min must not exceed max'),
);
export const PriceInfoSchema = v.pipe(
  v.strictObject({
    level: v.nullable(NonNegativeSafeIntegerSchema),
    range: v.nullable(PriceRangeSchema),
    rawLabel: v.nullable(v.pipe(v.string(), v.maxLength(160))),
  }),
  v.check(
    (price) => price.level !== null || price.range !== null || price.rawLabel !== null,
    'price value must contain a level, range, or raw label',
  ),
);
export type PriceInfo = v.InferOutput<typeof PriceInfoSchema>;

export const PhotoAttributionSchema = v.strictObject({
  displayName: Text(160),
  uri: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});
export const PhotoSchema = v.strictObject({
  photoRef: Text(512),
  attributions: v.array(PhotoAttributionSchema),
  sourceUrl: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});
export const PhotoInfoSchema = v.strictObject({
  photos: v.pipe(v.array(PhotoSchema), v.maxLength(3)),
});

export const ContactInfoSchema = v.strictObject({
  websiteUrl: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
  phone: v.nullable(v.pipe(v.string(), v.maxLength(64))),
  mapUrl: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});

export const FacilitiesInfoSchema = v.strictObject({
  wifi: v.picklist(['yes', 'no', 'partial', 'unknown']),
  nonSmoking: v.picklist(['yes', 'no', 'partial', 'unknown']),
  privateRoom: v.picklist(['yes', 'no', 'partial', 'unknown']),
  parking: v.picklist(['yes', 'no', 'partial', 'unknown']),
  sourceText: v.array(Text(300)),
});

export const WalkingRouteSchema = v.strictObject({
  originRef: OpaqueIdSchema,
  destinationCandidateId: CandidateIdSchema,
  originRevision: RevisionSchema,
  evaluatedAt: IsoTimestampSchema,
  durationSeconds: NonNegativeSafeIntegerSchema,
  distanceMeters: NonNegativeFiniteNumberSchema,
  warnings: v.array(v.strictObject({ code: Text(80), message: Text(300) })),
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
    'transfer must arrive at or after departure',
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
    placeToStationSeconds: NonNegativeSafeIntegerSchema,
    arrivePlaceAt: IsoTimestampSchema,
    leaveBy: IsoTimestampSchema,
    availableStaySeconds: SafeIntegerSchema,
    minimumStayMinutes: v.pipe(NonNegativeSafeIntegerSchema, v.minValue(1), v.maxValue(180)),
    usable: v.boolean(),
  }),
  v.check(
    (info) => !info.usable || info.availableStaySeconds >= info.minimumStayMinutes * 60,
    'usable last train must satisfy minimum stay',
  ),
);
export type LastTrainInfo = v.InferOutput<typeof LastTrainInfoSchema>;
