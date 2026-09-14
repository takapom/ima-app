import * as v from 'valibot';

export const HOT_PEPPER_PROVIDER = 'hotpepper' as const;
export const HOT_PEPPER_GOURMET_ENDPOINT = 'https://webservice.recruit.co.jp/hotpepper/gourmet/v1/';
export const HOT_PEPPER_MATCH_DISTANCE_METERS = 50;
export const HOT_PEPPER_MIN_NAME_SIMILARITY = 0.8;

const finiteCoordinate = (minimum: number, maximum: number) =>
  v.pipe(
    v.number(),
    v.check((value) => Number.isFinite(value), 'coordinate must be finite'),
    v.minValue(minimum),
    v.maxValue(maximum),
  );

const nonBlankText = (maximum: number) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(maximum),
    v.check((value) => value.trim().length > 0, 'text must not be blank'),
  );

export const HotPepperSearchRequestSchema = v.pipe(
  v.strictObject({
    keyword: v.optional(nonBlankText(400)),
    id: v.optional(v.pipe(v.array(nonBlankText(128)), v.minLength(1), v.maxLength(20))),
    lat: v.optional(finiteCoordinate(-90, 90)),
    lng: v.optional(finiteCoordinate(-180, 180)),
    range: v.optional(
      v.union([v.literal(1), v.literal(2), v.literal(3), v.literal(4), v.literal(5)]),
    ),
    count: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(20))),
    start: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
  }),
  v.check(
    (request) =>
      (request.keyword !== undefined || request.id !== undefined || request.lat !== undefined) &&
      (request.lat === undefined) === (request.lng === undefined),
    'a search condition and paired coordinates are required',
  ),
);
export type HotPepperSearchRequest = v.InferOutput<typeof HotPepperSearchRequestSchema>;

export const HotPepperCandidateReferenceSchema = v.strictObject({
  candidateId: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(128),
    v.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  ),
  name: nonBlankText(160),
  lat: finiteCoordinate(-90, 90),
  lng: finiteCoordinate(-180, 180),
  /** A previously verified Hot Pepper record is optional and remains server-owned metadata. */
  hotPepperRecordRef: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(128), v.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u)),
  ),
});
export type HotPepperCandidateReference = v.InferOutput<typeof HotPepperCandidateReferenceSchema>;

export type HotPepperField = 'opening_hours' | 'price' | 'facilities' | 'source';
export type HotPepperPolicyUse = 'llm_input' | 'display' | 'persistence' | 'attribution';
export type HotPepperPolicyDecision = 'allow' | 'deny' | 'unknown';
export type HotPepperPolicyActivation = 'fixture_only' | 'disabled_until_m35' | 'live_verified';

export type HotPepperPolicyRecord = {
  readonly decision: HotPepperPolicyDecision;
  readonly activation: HotPepperPolicyActivation;
};

export type HotPepperFieldPolicy = (
  field: HotPepperField,
  use: HotPepperPolicyUse,
) => HotPepperPolicyRecord;

/** Separate gate for sending a candidate name/location to an optional provider. */
export type HotPepperProviderInputPolicy = () => HotPepperPolicyRecord;

export type HotPepperRuntimeMode = 'fixture' | 'live';

const DEFAULT_DENY_POLICY: HotPepperPolicyRecord = Object.freeze({
  decision: 'deny',
  activation: 'disabled_until_m35',
});

/** M35 has not verified Hot Pepper usage; a missing policy is deny by default. */
export const denyHotPepperFieldPolicy: HotPepperFieldPolicy = () => DEFAULT_DENY_POLICY;
export const denyHotPepperProviderInputPolicy: HotPepperProviderInputPolicy = () =>
  DEFAULT_DENY_POLICY;

export const hotPepperPolicyRecordAllows = (
  record: HotPepperPolicyRecord,
  mode: HotPepperRuntimeMode,
): boolean => {
  const activationAllowed =
    mode === 'fixture'
      ? record.activation === 'fixture_only' || record.activation === 'live_verified'
      : record.activation === 'live_verified';
  return record.decision === 'allow' && activationAllowed;
};

export const hotPepperPolicyAllows = (
  policy: HotPepperFieldPolicy,
  field: HotPepperField,
  use: HotPepperPolicyUse,
  mode: HotPepperRuntimeMode = 'live',
): boolean => {
  try {
    const record = policy(field, use);
    return hotPepperPolicyRecordAllows(record, mode);
  } catch {
    return false;
  }
};

export type HotPepperFieldResult<T> =
  | { readonly status: 'known'; readonly value: T }
  | { readonly status: 'unknown'; readonly reason: string }
  | { readonly status: 'unsupported'; readonly reason: string }
  | {
      readonly status: 'error';
      readonly code: Extract<HotPepperFailureCode, 'SCHEMA_MISMATCH' | 'SOURCE_CONFLICT'>;
      readonly reason: string;
    };

export type HotPepperOpeningHoursSupplement = {
  /** HP `open` is a schedule description and is never treated as a close instant. */
  readonly openText: string | null;
  /** HP `close` means regular holidays in this API contract. */
  readonly regularHolidayText: string | null;
  readonly lastOrderRaw: string | null;
  readonly lastOrderAt: null;
};

export type HotPepperPriceSupplement = {
  readonly budgetLabel: string | null;
  readonly averageLabel: string | null;
  /** No currency or per-person unit is inferred from HP budget strings. */
  readonly unit: 'unknown';
};

export type HotPepperFacilityValue = 'yes' | 'no' | 'partial' | 'unknown';

export type HotPepperFacilitiesSupplement = {
  readonly wifi: HotPepperFacilityValue;
  readonly nonSmoking: HotPepperFacilityValue;
  readonly privateRoom: HotPepperFacilityValue;
  readonly parking: HotPepperFacilityValue;
  readonly sourceText: readonly string[];
};

export type HotPepperSource = {
  readonly provider: typeof HOT_PEPPER_PROVIDER;
  readonly recordRef: string;
  readonly attribution: 'ホットペッパー';
  readonly publicUrl: string;
};

export type HotPepperSupplement = {
  readonly candidateId: string;
  readonly match: {
    readonly recordRef: string;
    readonly distanceMeters: number;
    readonly nameSimilarity: number;
  };
  readonly source: HotPepperSource;
  readonly openingHours: HotPepperFieldResult<HotPepperOpeningHoursSupplement>;
  readonly price: HotPepperFieldResult<HotPepperPriceSupplement>;
  readonly facilities: HotPepperFieldResult<HotPepperFacilitiesSupplement>;
};

export type HotPepperFailureCode =
  | 'MISSING_API_KEY'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'SCHEMA_MISMATCH'
  | 'NO_MATCH'
  | 'AMBIGUOUS_MATCH'
  | 'SOURCE_CONFLICT'
  | 'MISSING_ATTRIBUTION'
  | 'POLICY_DENIED'
  | 'UNSUPPORTED';

export type HotPepperErrorOptions = {
  readonly status?: number | null;
  readonly retryAfterMs?: number | null;
};

/** Provider errors contain only a stable code and bounded HTTP metadata. */
export class HotPepperError extends Error {
  readonly code: HotPepperFailureCode;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(code: HotPepperFailureCode, options: HotPepperErrorOptions = {}) {
    super(`Hot Pepper provider failed: ${code}`);
    this.name = 'HotPepperError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}
