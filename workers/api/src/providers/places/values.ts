import * as v from 'valibot';
import { ContactInfoSchema, PhotoInfoSchema, PriceInfoSchema, type PriceInfo } from '@ima/core';
import type { GooglePlaceWire } from './wire';

type ContactInfo = v.InferOutput<typeof ContactInfoSchema>;
type PhotoInfo = v.InferOutput<typeof PhotoInfoSchema>;

export type GoogleNormalizationErrorCode = 'SCHEMA_MISMATCH' | 'SOURCE_CONFLICT';

export type GoogleNormalizedValue<T> =
  | { readonly status: 'known'; readonly value: T }
  | { readonly status: 'unknown'; readonly reason: string }
  | {
      readonly status: 'error';
      readonly code: GoogleNormalizationErrorCode;
      readonly reason: string;
    };

type UriResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly reason: string };

/** Provider links are retained only when they are valid HTTPS URLs. */
export const normalizeGoogleHttpsUri = (
  value: string | undefined,
  allowProtocolRelative = false,
): UriResult => {
  if (value === undefined || value.length === 0) return { ok: true, value: null };
  const candidate = allowProtocolRelative && value.startsWith('//') ? `https:${value}` : value;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:') {
      return { ok: false, reason: 'provider URL must use HTTPS' };
    }
    return { ok: true, value: candidate };
  } catch {
    return { ok: false, reason: 'provider URL is invalid' };
  }
};

const errorValue = <T>(
  code: GoogleNormalizationErrorCode,
  reason: string,
): GoogleNormalizedValue<T> => ({ status: 'error', code, reason });

const validateValue = <T>(
  schema: v.GenericSchema<unknown, T>,
  value: T,
): GoogleNormalizedValue<T> => {
  const parsed = v.safeParse(schema, value);
  return parsed.success
    ? { status: 'known', value: parsed.output }
    : errorValue('SCHEMA_MISMATCH', 'normalized value did not satisfy the Core schema');
};

const normalizePriceLevel = (
  value: string | undefined,
): { readonly level: number | null } | { readonly error: string } => {
  if (value === undefined || value === 'PRICE_LEVEL_UNSPECIFIED') return { level: null };
  const levels: Record<string, number> = {
    PRICE_LEVEL_FREE: 0,
    PRICE_LEVEL_INEXPENSIVE: 1,
    PRICE_LEVEL_MODERATE: 2,
    PRICE_LEVEL_EXPENSIVE: 3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4,
  };
  const level = levels[value];
  return level === undefined ? { error: 'provider returned an unknown price level' } : { level };
};

const normalizeMoney = (
  money: NonNullable<GooglePlaceWire['priceRange']>['startPrice'],
): { readonly amount: number; readonly currency: string } | { readonly error: string } => {
  if (money === undefined) return { error: 'price range amount is missing' };
  const units = Number(money.units);
  if (!Number.isSafeInteger(units)) return { error: 'price range units exceed safe precision' };
  const nanos = money.nanos;
  if ((units > 0 && nanos < 0) || (units < 0 && nanos > 0)) {
    return { error: 'price range units and nanos have conflicting signs' };
  }
  const amount = units + nanos / 1_000_000_000;
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: 'price range amount must be a non-negative finite number' };
  }
  return { amount, currency: money.currencyCode };
};

export const normalizeGooglePrice = (place: GooglePlaceWire): GoogleNormalizedValue<PriceInfo> => {
  const levelResult = normalizePriceLevel(place.priceLevel);
  if ('error' in levelResult) return errorValue('SCHEMA_MISMATCH', levelResult.error);

  let range: PriceInfo['range'] = null;
  const sourceRange = place.priceRange;
  if (sourceRange !== undefined) {
    const hasStart = sourceRange.startPrice !== undefined;
    const hasEnd = sourceRange.endPrice !== undefined;
    if (hasStart && hasEnd) {
      const start = normalizeMoney(sourceRange.startPrice);
      const end = normalizeMoney(sourceRange.endPrice);
      if ('error' in start) return errorValue('SCHEMA_MISMATCH', start.error);
      if ('error' in end) return errorValue('SCHEMA_MISMATCH', end.error);
      if (start.currency !== end.currency) {
        return errorValue('SOURCE_CONFLICT', 'price range currencies do not match');
      }
      if (start.amount > end.amount) {
        return errorValue('SOURCE_CONFLICT', 'price range lower bound exceeds upper bound');
      }
      range = {
        currency: start.currency,
        min: start.amount,
        max: end.amount,
        unit: 'unknown',
      };
    }
  }

  const value: PriceInfo = { level: levelResult.level, range, rawLabel: null };
  if (value.level === null && value.range === null) {
    return {
      status: 'unknown',
      reason:
        sourceRange === undefined
          ? 'Google did not provide a price level or complete price range'
          : 'Google price range has no finite lower and upper bounds',
    };
  }
  return validateValue(PriceInfoSchema, value);
};

export const normalizeGoogleContact = (
  place: GooglePlaceWire,
): GoogleNormalizedValue<ContactInfo> => {
  const website = normalizeGoogleHttpsUri(place.websiteUri);
  if (!website.ok) return errorValue('SCHEMA_MISMATCH', website.reason);
  const map = normalizeGoogleHttpsUri(place.googleMapsUri);
  if (!map.ok) return errorValue('SCHEMA_MISMATCH', map.reason);

  const candidatePhone = place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? null;
  const phone = candidatePhone === '' ? null : candidatePhone;
  if (phone !== null && phone.length > 64) {
    return errorValue('SCHEMA_MISMATCH', 'provider phone number is too long');
  }
  const value: ContactInfo = {
    websiteUrl: website.value,
    phone,
    mapUrl: map.value,
  };
  if (value.websiteUrl === null && value.phone === null && value.mapUrl === null) {
    return { status: 'unknown', reason: 'Google did not provide contact details' };
  }
  return validateValue(ContactInfoSchema, value);
};

export const normalizeGooglePhotos = (place: GooglePlaceWire): GoogleNormalizedValue<PhotoInfo> => {
  if (place.photos === undefined || place.photos.length === 0) {
    return { status: 'unknown', reason: 'Google did not provide photo metadata' };
  }

  const photos: PhotoInfo['photos'] = [];
  for (const photo of place.photos) {
    if (photos.length === 3) break;
    if (!/^places\/[^/]+\/photos\/[^/]+$/u.test(photo.name)) {
      return errorValue('SCHEMA_MISMATCH', 'provider photo reference has an invalid shape');
    }
    const source = normalizeGoogleHttpsUri(photo.googleMapsUri ?? place.googleMapsUri);
    if (!source.ok) return errorValue('SCHEMA_MISMATCH', source.reason);

    const attributions: PhotoInfo['photos'][number]['attributions'] = [];
    for (const attribution of photo.authorAttributions ?? []) {
      if (attribution.displayName === undefined || attribution.displayName.length === 0) {
        continue;
      }
      const uri = normalizeGoogleHttpsUri(attribution.uri, true);
      if (!uri.ok) return errorValue('SCHEMA_MISMATCH', uri.reason);
      attributions.push({ displayName: attribution.displayName, uri: uri.value });
    }
    if (attributions.length === 0) continue;
    photos.push({ photoRef: photo.name, attributions, sourceUrl: source.value });
  }

  if (photos.length === 0) {
    return {
      status: 'unknown',
      reason: 'Google photo metadata has no displayable author attribution',
    };
  }
  return validateValue(PhotoInfoSchema, { photos });
};
