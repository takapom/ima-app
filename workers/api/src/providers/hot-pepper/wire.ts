import * as v from 'valibot';
import { HotPepperError, type HotPepperFailureCode } from './types';

const providerText = (maxLength: number) => v.nullable(v.pipe(v.string(), v.maxLength(maxLength)));
const optionalProviderText = (maxLength: number) => v.optional(providerText(maxLength));
const providerScalar = v.nullable(
  v.union([
    v.pipe(v.string(), v.maxLength(500)),
    v.pipe(
      v.number(),
      v.check((value) => Number.isFinite(value), 'provider number must be finite'),
    ),
    v.boolean(),
  ]),
);
const optionalProviderScalar = v.optional(providerScalar);
const coordinate = (minimum: number, maximum: number) =>
  v.nullable(
    v.pipe(
      v.number(),
      v.check((value) => Number.isFinite(value), 'provider coordinate must be finite'),
      v.minValue(minimum),
      v.maxValue(maximum),
    ),
  );

const HotPepperBudgetWireSchema = v.object({
  code: optionalProviderText(64),
  name: optionalProviderText(160),
  average: optionalProviderText(160),
  budget_memo: optionalProviderText(300),
});

const HotPepperGenreWireSchema = v.object({
  code: optionalProviderText(64),
  name: optionalProviderText(160),
});

const HotPepperUrlsWireSchema = v.object({
  pc: optionalProviderText(2_048),
  mobile: optionalProviderText(2_048),
});

/**
 * Allowlisted Gourmet Search fields. `close` is retained as provider holiday text;
 * it is deliberately not named or interpreted as an absolute closing time.
 */
export const HotPepperShopWireSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(128), v.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u)),
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(160),
    v.check((value) => value.trim().length > 0, 'shop name must not be blank'),
  ),
  address: optionalProviderText(500),
  lat: coordinate(-90, 90),
  lng: coordinate(-180, 180),
  open: optionalProviderText(2_000),
  close: optionalProviderText(500),
  last_order: optionalProviderText(160),
  budget: v.optional(HotPepperBudgetWireSchema),
  genre: v.optional(HotPepperGenreWireSchema),
  urls: v.optional(HotPepperUrlsWireSchema),
  catch: optionalProviderText(500),
  access: optionalProviderText(500),
  wifi: optionalProviderScalar,
  non_smoking: optionalProviderScalar,
  private_room: optionalProviderScalar,
  parking: optionalProviderScalar,
  other_memo: optionalProviderText(500),
  shop_detail_memo: optionalProviderText(500),
});
export type HotPepperShopWire = v.InferOutput<typeof HotPepperShopWireSchema>;

const HotPepperErrorWireSchema = v.object({
  code: v.optional(v.union([v.string(), v.number()])),
  message: v.optional(v.pipe(v.string(), v.maxLength(500))),
});
export type HotPepperErrorWire = v.InferOutput<typeof HotPepperErrorWireSchema>;

const HotPepperResultsWireSchema = v.object({
  results_available: v.optional(
    v.pipe(
      v.number(),
      v.check((value) => Number.isFinite(value), 'result count must be finite'),
      v.safeInteger(),
      v.minValue(0),
    ),
  ),
  results_start: v.optional(
    v.pipe(
      v.number(),
      v.check((value) => Number.isFinite(value), 'result offset must be finite'),
      v.safeInteger(),
      v.minValue(1),
    ),
  ),
  shop: v.optional(v.pipe(v.array(HotPepperShopWireSchema), v.maxLength(100))),
  error: v.optional(v.union([v.array(HotPepperErrorWireSchema), HotPepperErrorWireSchema])),
});

export const HotPepperResponseSchema = v.object({
  results: HotPepperResultsWireSchema,
});

export type HotPepperResponseWire = v.InferOutput<typeof HotPepperResponseSchema>;
export type HotPepperSearchPage = {
  readonly shops: readonly HotPepperShopWire[];
  readonly resultsAvailable: number | null;
  readonly resultsStart: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const errorCodeFor = (code: string | number | undefined): HotPepperFailureCode => {
  const numeric = typeof code === 'number' ? code : Number(code);
  if (numeric === 2000 || numeric === 3000) return 'INVALID_REQUEST';
  if (numeric === 1000) return 'UPSTREAM_UNAVAILABLE';
  return 'UPSTREAM_UNAVAILABLE';
};

const errorEntriesFor = (
  error: HotPepperResponseWire['results']['error'],
): readonly HotPepperErrorWire[] => {
  if (error === undefined) return [];
  return Array.isArray(error) ? error : [error];
};

/** Parses only the documented response envelope and strips all unlisted provider properties. */
export const parseHotPepperResponse = (value: unknown): HotPepperSearchPage => {
  if (!isRecord(value) || !isRecord(value.results)) throw new HotPepperError('SCHEMA_MISMATCH');
  const parsed = v.safeParse(HotPepperResponseSchema, value);
  if (!parsed.success) throw new HotPepperError('SCHEMA_MISMATCH');
  const errors = errorEntriesFor(parsed.output.results.error);
  if (errors.length > 0) {
    throw new HotPepperError(errorCodeFor(errors[0]?.code));
  }
  return {
    shops: parsed.output.results.shop ?? [],
    resultsAvailable: parsed.output.results.results_available ?? null,
    resultsStart: parsed.output.results.results_start ?? null,
  };
};
