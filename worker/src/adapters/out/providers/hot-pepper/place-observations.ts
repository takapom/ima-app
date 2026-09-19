import * as v from 'valibot';
import {
  FacilitiesInfoSchema,
  OpeningHoursSchema,
  PhotoInfoSchema,
  PlaceIdentitySchema,
  PriceInfoSchema,
} from '@worker/domain/places/place-values';
import { ObservationSchema } from '@worker/domain/evidence/evidence';
import { type HarnessContext } from '@worker/application/ports/context';
import { type Issue } from '@worker/domain/issue';
import { type ObservationContext } from '@worker/domain/evidence/freshness';
import type { PlacesSearchRegistration } from '@worker/adapters/out/providers/places-search/registration';
import {
  hotPepperSourceFor,
  normalizeHotPepperFacilities,
  normalizeHotPepperPrice,
} from '@worker/adapters/out/providers/hot-pepper/normalize';
import { HotPepperError } from '@worker/adapters/out/providers/hot-pepper/types';
import type { HotPepperShopWire } from '@worker/adapters/out/providers/hot-pepper/wire';
import { HotPepperPhotoUrlSchema } from '@worker/security/photo-resource-policy';

/** Optional identity text is omitted rather than emptied, so absence stays distinguishable. */
const boundedIdentityText = (
  value: string | null | undefined,
  maxLength: number,
): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > maxLength ? undefined : trimmed;
};

export const hotPepperFieldSchemas = {
  identity: PlaceIdentitySchema,
  opening_hours: OpeningHoursSchema,
  price: PriceInfoSchema,
  facilities: FacilitiesInfoSchema,
  photos: PhotoInfoSchema,
};
export type HotPepperDetailField = keyof typeof hotPepperFieldSchemas;
export const isHotPepperDetailField = (field: string): field is HotPepperDetailField =>
  Object.hasOwn(hotPepperFieldSchemas, field);

export const hotPepperIssue = (
  code: Issue['code'],
  path: string | null,
  message: string,
  retryable = false,
  retryAfterMs: number | null = null,
): Issue => ({ code, path, message, retryable, retryAfterMs, missingFields: [] });

export const hotPepperProviderIssue = (error: unknown): Issue => {
  if (!(error instanceof HotPepperError)) {
    return hotPepperIssue('UPSTREAM_UNAVAILABLE', null, 'Hot Pepper is unavailable', true);
  }
  const code: Issue['code'] =
    error.status === 401 || error.status === 403
      ? 'UPSTREAM_UNAVAILABLE'
      : error.code === 'MISSING_API_KEY'
        ? 'MISSING_CONTEXT'
        : error.code === 'INVALID_REQUEST'
          ? 'INVALID_ARGUMENT'
          : error.code === 'NOT_FOUND'
            ? 'UNKNOWN_CANDIDATE'
            : error.code === 'TIMEOUT' ||
                error.code === 'CANCELLED' ||
                error.code === 'RATE_LIMITED' ||
                error.code === 'SCHEMA_MISMATCH' ||
                error.code === 'SOURCE_CONFLICT'
              ? error.code
              : 'UPSTREAM_UNAVAILABLE';
  return hotPepperIssue(
    code,
    null,
    `Hot Pepper: ${error.code}`,
    code === 'TIMEOUT' || code === 'RATE_LIMITED' || code === 'UPSTREAM_UNAVAILABLE',
    error.retryAfterMs,
  );
};

export const hotPepperObservationContext = (context: HarnessContext): ObservationContext => ({
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
  capabilityVersion: context.capabilities.version,
  locationRevision: context.location.revision,
  originRef: null,
  homeStationRef: context.preferences.homeStationRef,
  minimumStayMinutes: context.preferences.minimumStayMinutes,
  timeContext: 'now',
});

const fieldValue = (
  shop: HotPepperShopWire,
  field: HotPepperDetailField,
  area: string,
  now: string,
): unknown => {
  switch (field) {
    case 'photos': {
      const photo = shop.photo?.pc;
      const photoRef = [photo?.l, photo?.m, photo?.s].find((url) =>
        v.is(HotPepperPhotoUrlSchema, url),
      );
      if (photoRef === undefined) return undefined;
      const sourceUrl = hotPepperSourceFor(shop).publicUrl;
      return {
        photos: [
          {
            photoRef,
            attributions: [{ displayName: 'ホットペッパー グルメ', uri: sourceUrl }],
            sourceUrl,
          },
        ],
      };
    }
    case 'identity': {
      // Station and access are listed route text, never a measured walking route. They are carried
      // for display only; a walking constraint still needs walking_route evidence.
      const stationName = boundedIdentityText(shop.station_name, 160);
      const accessText = boundedIdentityText(shop.access, 500);
      return {
        name: shop.name,
        address: shop.address ?? null,
        area,
        category: shop.genre?.name ?? null,
        stationName: stationName ?? null,
        accessText: accessText ?? null,
        businessStatus: 'unknown',
        sourceUrl: hotPepperSourceFor(shop).publicUrl,
      };
    }
    case 'opening_hours': {
      // Free-form opening/holiday text does not establish an opening interval or open-now status.
      const weeklyText = [
        shop.open,
        shop.close === null || shop.close === undefined ? null : `定休日: ${shop.close}`,
      ].flatMap((text) => (text?.trim() ? (text.match(/[\s\S]{1,300}/gu) ?? []) : []));
      return weeklyText.length === 0
        ? undefined
        : {
            timeZone: 'Asia/Tokyo',
            intervals: [],
            weeklyText,
            evaluatedAt: now,
            listedOpenAtEvaluation: null,
            nextBoundaryAt: null,
            lastOrderAt: null,
            lastOrderRaw: null,
          };
    }
    case 'price': {
      // `budget.name` is the listed price band ("2001～3000円"). `budget.average` is free-form and
      // can carry promotional text, so it is only the fallback when no band is listed.
      const price = normalizeHotPepperPrice(shop);
      return price.status !== 'known'
        ? undefined
        : {
            level: null,
            range: null,
            rawLabel: price.value.budgetLabel ?? price.value.averageLabel,
          };
    }
    case 'facilities': {
      const facilities = normalizeHotPepperFacilities(shop);
      return facilities.status === 'known' ? facilities.value : undefined;
    }
  }
};

export const registerHotPepperField = (input: {
  readonly shop: HotPepperShopWire;
  readonly field: HotPepperDetailField;
  readonly candidateId: string;
  readonly area: string;
  readonly now: string;
  readonly context: HarnessContext;
  readonly registration: PlacesSearchRegistration;
}): unknown => {
  const { shop, field, context } = input;
  try {
    const value = fieldValue(shop, field, input.area, input.now);
    if (value === undefined)
      return { status: 'unknown', reason: 'Hot Pepper did not supply this field' };
    const parsed = v.safeParse(hotPepperFieldSchemas[field], value);
    if (!parsed.success) throw new HotPepperError('SCHEMA_MISMATCH');
    const source = hotPepperSourceFor(shop);
    const stored = input.registration.registerObservation({
      scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      candidateId: input.candidateId,
      field,
      value: parsed.output,
      basis: 'provider_reported',
      sourceUpdatedAt: null,
      context: hotPepperObservationContext(context),
      sources: [
        {
          provider: 'hotpepper',
          recordRef: shop.id,
          attribution: 'ホットペッパー グルメ',
          publicUrl: source.publicUrl,
        },
        {
          provider: 'hotpepper',
          recordRef: shop.id,
          attribution: 'Powered by ホットペッパーグルメ Webサービス',
          publicUrl: 'https://webservice.recruit.co.jp/',
        },
      ],
    });
    const observation = v.safeParse(ObservationSchema(hotPepperFieldSchemas[field]), stored);
    if (!observation.success) throw new HotPepperError('SCHEMA_MISMATCH');
    return { status: 'known', observations: [observation.output] };
  } catch (error) {
    return { status: 'error', error: hotPepperProviderIssue(error) };
  }
};
