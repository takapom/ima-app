import * as v from 'valibot';

const ShortTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const UrlTextSchema = v.pipe(v.string(), v.maxLength(2_048));

const GoogleDateSchema = v.strictObject({
  year: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(9_999)),
  month: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(12)),
  day: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(31)),
});

const GoogleLocalizedTextSchema = v.object({
  text: v.optional(v.pipe(v.string(), v.maxLength(300))),
  languageCode: v.optional(v.pipe(v.string(), v.maxLength(32))),
});

const GoogleAuthorAttributionSchema = v.object({
  displayName: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(160))),
  uri: v.optional(UrlTextSchema),
  photoUri: v.optional(UrlTextSchema),
});

const GooglePhotoSchema = v.object({
  name: ShortTextSchema,
  widthPx: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
  heightPx: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
  authorAttributions: v.optional(v.pipe(v.array(GoogleAuthorAttributionSchema), v.maxLength(8))),
  flagContentUri: v.optional(UrlTextSchema),
  googleMapsUri: v.optional(UrlTextSchema),
});

const GoogleMoneySchema = v.object({
  currencyCode: v.pipe(v.string(), v.regex(/^[A-Z]{3}$/u)),
  // Protobuf JSON omits zero-valued units/nanos; the default is applied at the wire boundary.
  units: v.optional(v.pipe(v.string(), v.regex(/^-?(?:0|[1-9]\d*)$/u), v.maxLength(20)), '0'),
  nanos: v.optional(
    v.pipe(v.number(), v.safeInteger(), v.minValue(-999_999_999), v.maxValue(999_999_999)),
    0,
  ),
});

const GooglePriceRangeSchema = v.object({
  startPrice: v.optional(GoogleMoneySchema),
  endPrice: v.optional(GoogleMoneySchema),
});

const GoogleOpeningPointSchema = v.object({
  date: v.optional(GoogleDateSchema),
  truncated: v.optional(v.boolean()),
  day: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(6))),
  hour: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(23))),
  minute: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(59))),
});

const GoogleOpeningPeriodSchema = v.object({
  open: v.optional(GoogleOpeningPointSchema),
  close: v.optional(GoogleOpeningPointSchema),
});

const GoogleSpecialDaySchema = v.object({ date: GoogleDateSchema });

/** Shared raw shape for M11 search and M12 details; it is not a public DTO. */
export const GoogleOpeningHoursSchema = v.object({
  periods: v.optional(v.pipe(v.array(GoogleOpeningPeriodSchema), v.maxLength(100))),
  weekdayDescriptions: v.optional(
    v.pipe(v.array(v.pipe(v.string(), v.maxLength(300))), v.maxLength(14)),
  ),
  secondaryHoursType: v.optional(v.pipe(v.string(), v.maxLength(64))),
  specialDays: v.optional(v.pipe(v.array(GoogleSpecialDaySchema), v.maxLength(14))),
  nextOpenTime: v.optional(v.pipe(v.string(), v.maxLength(80))),
  nextCloseTime: v.optional(v.pipe(v.string(), v.maxLength(80))),
  openNow: v.optional(v.boolean()),
});

const GoogleTimeZoneSchema = v.object({
  id: ShortTextSchema,
  version: v.optional(v.pipe(v.string(), v.maxLength(64))),
});

const GoogleProviderAttributionSchema = v.object({
  provider: ShortTextSchema,
  providerUri: UrlTextSchema,
});

const identityFields = {
  name: v.optional(ShortTextSchema),
  id: v.optional(ShortTextSchema),
  displayName: v.optional(GoogleLocalizedTextSchema),
  formattedAddress: v.optional(v.pipe(v.string(), v.maxLength(500))),
  primaryType: v.optional(v.pipe(v.string(), v.maxLength(120))),
  businessStatus: v.optional(v.pipe(v.string(), v.maxLength(64))),
  googleMapsUri: v.optional(UrlTextSchema),
  movedPlace: v.optional(ShortTextSchema),
  movedPlaceId: v.optional(ShortTextSchema),
};

const priceFields = {
  priceLevel: v.optional(v.pipe(v.string(), v.maxLength(64))),
  priceRange: v.optional(GooglePriceRangeSchema),
};

const contactFields = {
  googleMapsUri: v.optional(UrlTextSchema),
  websiteUri: v.optional(UrlTextSchema),
  nationalPhoneNumber: v.optional(v.pipe(v.string(), v.maxLength(64))),
  internationalPhoneNumber: v.optional(v.pipe(v.string(), v.maxLength(64))),
};

const photoFields = {
  googleMapsUri: v.optional(UrlTextSchema),
  photos: v.optional(v.pipe(v.array(GooglePhotoSchema), v.maxLength(10))),
};

const GooglePlaceIdentityWireSchema = v.object(identityFields);
const GooglePlacePriceWireSchema = v.object(priceFields);
const GooglePlaceContactWireSchema = v.object(contactFields);
const GooglePlacePhotoWireSchema = v.object(photoFields);
const GooglePlaceOpeningHoursWireSchema = v.object({
  currentOpeningHours: v.optional(GoogleOpeningHoursSchema),
  regularOpeningHours: v.optional(GoogleOpeningHoursSchema),
  timeZone: v.optional(GoogleTimeZoneSchema),
});
const GooglePlaceSourceWireSchema = v.object({
  googleMapsUri: v.optional(UrlTextSchema),
  attributions: v.optional(v.pipe(v.array(GoogleProviderAttributionSchema), v.maxLength(8))),
});

/**
 * Allowlisted subset of the Google Places REST Place resource.
 * Unknown response properties are stripped at this boundary instead of being forwarded.
 */
export const GooglePlaceWireSchema = v.object({
  ...identityFields,
  ...priceFields,
  ...contactFields,
  ...photoFields,
  attributions: v.optional(v.pipe(v.array(GoogleProviderAttributionSchema), v.maxLength(8))),
  currentOpeningHours: v.optional(GoogleOpeningHoursSchema),
  regularOpeningHours: v.optional(GoogleOpeningHoursSchema),
  timeZone: v.optional(GoogleTimeZoneSchema),
});

export type GooglePlaceWire = v.InferOutput<typeof GooglePlaceWireSchema>;
export type GoogleOpeningHoursWire = v.InferOutput<typeof GoogleOpeningHoursSchema>;
export type GoogleTimeZoneWire = v.InferOutput<typeof GoogleTimeZoneSchema>;
export type GoogleProviderAttributionWire = v.InferOutput<typeof GoogleProviderAttributionSchema>;
export type GooglePhotoWire = v.InferOutput<typeof GooglePhotoSchema>;
export type GoogleMoneyWire = v.InferOutput<typeof GoogleMoneySchema>;
export type GooglePriceRangeWire = v.InferOutput<typeof GooglePriceRangeSchema>;

export type GooglePlaceWireField =
  'identity' | 'price' | 'contact' | 'photos' | 'opening_hours' | 'source';

export class GooglePlacesWireError extends Error {
  readonly code = 'SCHEMA_MISMATCH' as const;

  constructor() {
    super('Google Places response did not match the allowlisted wire shape');
    this.name = 'GooglePlacesWireError';
  }
}

export const parseGooglePlaceWire = (value: unknown): GooglePlaceWire => {
  const parsed = v.safeParse(GooglePlaceWireSchema, value);
  if (!parsed.success) throw new GooglePlacesWireError();
  return parsed.output;
};

/**
 * Parses one requested field in isolation so malformed unrelated data cannot erase a success.
 * Unknown properties are stripped by each field schema before normalization.
 */
export const parseGooglePlaceWireField = (
  field: GooglePlaceWireField,
  value: unknown,
): GooglePlaceWire => {
  switch (field) {
    case 'identity': {
      const parsed = v.safeParse(GooglePlaceIdentityWireSchema, value);
      if (!parsed.success) throw new GooglePlacesWireError();
      return parsed.output;
    }
    case 'price': {
      const parsed = v.safeParse(GooglePlacePriceWireSchema, value);
      if (!parsed.success) throw new GooglePlacesWireError();
      return parsed.output;
    }
    case 'contact': {
      const parsed = v.safeParse(GooglePlaceContactWireSchema, value);
      if (!parsed.success) throw new GooglePlacesWireError();
      return parsed.output;
    }
    case 'photos': {
      const parsed = v.safeParse(GooglePlacePhotoWireSchema, value);
      if (!parsed.success) throw new GooglePlacesWireError();
      return parsed.output;
    }
    case 'opening_hours': {
      const parsed = v.safeParse(GooglePlaceOpeningHoursWireSchema, value);
      if (!parsed.success) throw new GooglePlacesWireError();
      return parsed.output;
    }
    case 'source': {
      const parsed = v.safeParse(GooglePlaceSourceWireSchema, value);
      if (!parsed.success) throw new GooglePlacesWireError();
      return parsed.output;
    }
  }
};
