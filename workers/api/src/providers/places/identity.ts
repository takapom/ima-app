import * as v from 'valibot';
import { PlaceIdentitySchema, type PlaceIdentity } from '@ima/core';
import { normalizeGoogleHttpsUri, type GoogleNormalizedValue } from './values';
import type { GooglePlaceWire } from './wire';

export type GoogleIdentityMetadata = {
  /** Internal provider reference for a controlled future resolver; never a public ID. */
  readonly movedPlace: string | null;
  readonly movedPlaceId: string | null;
  readonly providerBusinessStatus: string | null;
};

export type GoogleIdentityNormalization = {
  readonly value: GoogleNormalizedValue<PlaceIdentity>;
  readonly metadata: GoogleIdentityMetadata;
};

const statusFor = (
  status: string | undefined,
): { readonly value: PlaceIdentity['businessStatus'] } | { readonly error: string } => {
  switch (status) {
    case undefined:
    case 'BUSINESS_STATUS_UNSPECIFIED':
      return { value: 'unknown' };
    case 'OPERATIONAL':
      return { value: 'operational' };
    case 'CLOSED_TEMPORARILY':
      return { value: 'temporarily_closed' };
    case 'CLOSED_PERMANENTLY':
      return { value: 'permanently_closed' };
    case 'FUTURE_OPENING':
      return { value: 'unknown' };
    default:
      return { error: 'provider returned an unknown business status' };
  }
};

const nullableText = (value: string | undefined): string | null =>
  value === undefined || value.length === 0 ? null : value;

export const normalizeGoogleIdentity = (
  place: GooglePlaceWire,
  areaLabel: string,
): GoogleIdentityNormalization => {
  const metadata: GoogleIdentityMetadata = {
    movedPlace: place.movedPlace ?? null,
    movedPlaceId: place.movedPlaceId ?? null,
    providerBusinessStatus: place.businessStatus ?? null,
  };
  if (areaLabel.length === 0 || areaLabel.length > 160) {
    return {
      value: {
        status: 'error',
        code: 'SCHEMA_MISMATCH',
        reason: 'host-provided area label is invalid',
      },
      metadata,
    };
  }

  const status = statusFor(place.businessStatus);
  if ('error' in status) {
    return {
      value: { status: 'error', code: 'SCHEMA_MISMATCH', reason: status.error },
      metadata,
    };
  }
  const hasMovedTarget = place.movedPlace !== undefined || place.movedPlaceId !== undefined;
  if (hasMovedTarget && place.businessStatus !== 'CLOSED_PERMANENTLY') {
    return {
      value: {
        status: 'error',
        code: 'SOURCE_CONFLICT',
        reason: 'provider supplied a moved place without permanent-closed status',
      },
      metadata,
    };
  }

  const source = normalizeGoogleHttpsUri(place.googleMapsUri);
  if (!source.ok) {
    return {
      value: { status: 'error', code: 'SCHEMA_MISMATCH', reason: source.reason },
      metadata,
    };
  }
  const name = place.displayName?.text;
  if (name === undefined || name.length === 0) {
    return {
      value: { status: 'unknown', reason: 'Google place display name is missing' },
      metadata,
    };
  }

  const identity: PlaceIdentity = {
    name,
    area: areaLabel,
    address: nullableText(place.formattedAddress),
    category: nullableText(place.primaryType),
    businessStatus: status.value,
    sourceUrl: source.value,
  };
  const parsed = v.safeParse(PlaceIdentitySchema, identity);
  if (!parsed.success) {
    return {
      value: {
        status: 'error',
        code: 'SCHEMA_MISMATCH',
        reason: 'normalized identity did not satisfy the Core schema',
      },
      metadata,
    };
  }
  return { value: { status: 'known', value: parsed.output }, metadata };
};
