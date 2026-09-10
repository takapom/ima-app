/**
 * Shared, secret-free result types for the opt-in provider smoke command.
 *
 * This file deliberately has no Worker/bootstrap import. The command can be run
 * from a local Bun process and the result can be asserted without starting a
 * production Worker or turning a fixture into a live-provider claim.
 */

export const SMOKE_CONFIRMATION_ENV = {
  live: 'IMA_PROVIDER_LIVE_CONFIRM',
  billing: 'IMA_PROVIDER_BILLING_CONFIRM',
  permission: 'IMA_PROVIDER_PERMISSION_CONFIRM',
} as const;

export const SMOKE_INPUT_ENV = {
  searchQuery: 'GOOGLE_SMOKE_SEARCH_QUERY',
  placeId: 'GOOGLE_SMOKE_PLACE_ID',
  photoRef: 'GOOGLE_SMOKE_PHOTO_REF',
  routeOriginPlaceId: 'GOOGLE_SMOKE_ROUTE_ORIGIN_PLACE_ID',
  routeDestinationPlaceId: 'GOOGLE_SMOKE_ROUTE_DESTINATION_PLACE_ID',
} as const;

export const SMOKE_KEY_ENV = {
  places: 'GOOGLE_PLACES_API_KEY',
  routes: 'GOOGLE_ROUTES_API_KEY',
} as const;

export type SmokeEnvironment = Readonly<Record<string, string | undefined>>;

export type SmokeProvider = 'places' | 'details' | 'routes' | 'photo' | 'journey';

export type SmokeResultStatus = 'passed' | 'skipped' | 'failed';

export type SmokeResultOutcome = 'success' | 'no_data' | 'not_run';

export type SmokeResult = {
  readonly provider: SmokeProvider;
  readonly status: SmokeResultStatus;
  readonly source: 'live' | 'none';
  readonly outcome: SmokeResultOutcome;
  /** A fixed classification code; upstream response text is never included. */
  readonly code: string;
  readonly calls: number;
};

export type SmokePreflightCheck = {
  readonly name: string;
  readonly status: 'configured' | 'missing';
};

export type SmokePreflight = {
  readonly status: 'ready' | 'partial' | 'blocked';
  readonly checks: readonly SmokePreflightCheck[];
  readonly providers: Readonly<Record<SmokeProvider, 'ready' | 'blocked'>>;
};

export type ProviderSmokeReport = {
  readonly mode: 'live';
  readonly preflight: SmokePreflight;
  readonly results: readonly SmokeResult[];
  readonly exitCode: 0 | 1 | 2;
};

export type JourneySmokeProbe = () => Promise<
  | { readonly source: 'live'; readonly ok: true }
  | { readonly source: 'live'; readonly ok: false; readonly code?: string }
  | { readonly source: 'fixture'; readonly ok: true }
  | { readonly source: 'fixture'; readonly ok: false; readonly code?: string }
>;

export const SMOKE_PROVIDERS: readonly SmokeProvider[] = [
  'places',
  'details',
  'routes',
  'photo',
  'journey',
];

export const envValue = (env: SmokeEnvironment, key: string): string | undefined => {
  const value = env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};

export const isConfirmed = (env: SmokeEnvironment, key: string): boolean =>
  envValue(env, key) === 'YES';

const SAFE_CODES = new Set([
  'MISSING_API_KEY',
  'INVALID_REQUEST',
  'RATE_LIMITED',
  'NOT_FOUND',
  'EXPIRED',
  'TIMEOUT',
  'CANCELLED',
  'UPSTREAM_UNAVAILABLE',
  'SCHEMA_MISMATCH',
  'UNSUPPORTED_MEDIA_TYPE',
  'RESULT_TOO_LARGE',
  'REDIRECT_REJECTED',
  'EMPTY_BODY',
  'NO_ROUTE',
  'NO_DATA',
  'IDENTITY_MISMATCH',
  'IDENTITY_INCOMPLETE',
  'FIXTURE_NOT_LIVE',
  'LIVE_DATASET_FAILED',
  'DATASET_NOT_CONFIGURED',
  'PREFLIGHT_BLOCKED',
  'SMOKE_BODY_TIMEOUT',
  'UNCLASSIFIED_ERROR',
]);

export const safeErrorCode = (error: unknown): string => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return 'UNCLASSIFIED_ERROR';
  }
  const code = error.code;
  return typeof code === 'string' && SAFE_CODES.has(code) ? code : 'UNCLASSIFIED_ERROR';
};

export const resultFor = (
  provider: SmokeProvider,
  status: SmokeResultStatus,
  code: string,
  calls = 0,
  source: 'live' | 'none' = status === 'passed' ? 'live' : 'none',
  outcome: SmokeResultOutcome = status === 'passed' ? 'success' : 'not_run',
): SmokeResult => ({
  provider,
  status,
  source,
  outcome,
  code,
  calls,
});

export const reportExitCode = (results: readonly SmokeResult[]): 0 | 1 | 2 => {
  if (results.some((result) => result.status === 'failed')) return 1;
  if (results.some((result) => result.status === 'skipped')) return 2;
  return 0;
};
