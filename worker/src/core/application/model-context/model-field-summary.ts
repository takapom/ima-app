import * as v from 'valibot';
import {
  FacilitiesInfoSchema,
  OpeningHoursSchema,
  PhotoInfoSchema,
  PlaceIdentitySchema,
  PriceInfoSchema,
} from '@worker/domain/places/place-values';
import type { DetailField } from '@worker/domain/primitives';

type FieldSummaryValue =
  | string
  | number
  | boolean
  | null
  | FieldSummaryValue[]
  | {
      [key: string]: FieldSummaryValue;
    };
export type ModelFieldSummary = { readonly [key: string]: FieldSummaryValue };

/**
 * What the model needs to judge one field. Observation IDs, fetch and expiry times, sources and
 * photo URLs stay in the harness, which tracks what was shown and whether it is still valid.
 * An unparseable value has no summary, so the caller withholds it.
 */
export const summarizeFieldForModel = (
  field: DetailField,
  value: unknown,
): ModelFieldSummary | undefined => {
  switch (field) {
    case 'identity': {
      const parsed = v.safeParse(PlaceIdentitySchema, value);
      if (!parsed.success) return undefined;
      const { name, category, area, address, stationName, accessText, businessStatus } =
        parsed.output;
      return {
        name,
        category,
        area,
        address,
        stationName,
        accessText,
        businessStatus,
        // Self-description by the shop; see the prompt for how it may be used.
        listingText: parsed.output.listingText ?? null,
      };
    }
    case 'opening_hours': {
      const parsed = v.safeParse(OpeningHoursSchema, value);
      if (!parsed.success) return undefined;
      const { weeklyText, listedOpenAtEvaluation, lastOrderRaw } = parsed.output;
      return { weeklyText: [...weeklyText], listedOpenAtEvaluation, lastOrderRaw };
    }
    case 'price': {
      const parsed = v.safeParse(PriceInfoSchema, value);
      if (!parsed.success) return undefined;
      const { level, range, rawLabel } = parsed.output;
      return { level, range: range === null ? null : { ...range }, rawLabel };
    }
    case 'facilities': {
      const parsed = v.safeParse(FacilitiesInfoSchema, value);
      if (!parsed.success) return undefined;
      const { wifi, nonSmoking, privateRoom, parking } = parsed.output;
      return { wifi, nonSmoking, privateRoom, parking };
    }
    case 'photos': {
      const parsed = v.safeParse(PhotoInfoSchema, value);
      return parsed.success ? { count: parsed.output.photos.length } : undefined;
    }
    case 'contact':
      return undefined;
  }
};
