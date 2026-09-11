import * as v from 'valibot';
import {
  operationalCapabilityMode,
  resolveOperationalFlags,
  type OperationalMode,
} from '../../telemetry/flags';
import {
  denyHotPepperFieldPolicy,
  denyHotPepperProviderInputPolicy,
  hotPepperPolicyAllows,
  hotPepperPolicyRecordAllows,
  HOT_PEPPER_PROVIDER,
  HotPepperCandidateReferenceSchema,
  HotPepperError,
  type HotPepperCandidateReference,
  type HotPepperField,
  type HotPepperFieldPolicy,
  type HotPepperFieldResult,
  type HotPepperPolicyUse,
  type HotPepperProviderInputPolicy,
  type HotPepperRuntimeMode,
  type HotPepperSupplement,
} from './types';
import { matchHotPepperShop, type HotPepperMatchPolicy } from './matching';
import {
  hotPepperSourceFor,
  normalizeHotPepperFacilities,
  normalizeHotPepperOpeningHours,
  normalizeHotPepperPrice,
} from './normalize';
import {
  createHotPepperTransport,
  type HotPepperTransport,
  type HotPepperTransportOptions,
} from './transport';

export type HotPepperAdapterResult =
  | { readonly status: 'ok'; readonly value: HotPepperSupplement }
  | { readonly status: 'unsupported'; readonly reason: string }
  | { readonly status: 'error'; readonly error: HotPepperError };

export type HotPepperAdapterOptions = {
  readonly transport: HotPepperTransport;
  readonly policy?: HotPepperFieldPolicy;
  readonly providerInputPolicy?: HotPepperProviderInputPolicy;
  readonly mode?: HotPepperRuntimeMode;
  readonly matchPolicy?: HotPepperMatchPolicy;
};

export interface HotPepperAdapter {
  readonly provider: typeof HOT_PEPPER_PROVIDER;
  readonly mode: HotPepperRuntimeMode;
  read(
    candidate: HotPepperCandidateReference,
    use?: HotPepperPolicyUse,
    signal?: AbortSignal,
  ): Promise<HotPepperAdapterResult>;
}

const policyWithheld = <T>(field: HotPepperField): HotPepperFieldResult<T> => ({
  status: 'unsupported',
  reason: `Hot Pepper ${field} is withheld by provider policy`,
});

const projectField = <T>(
  field: HotPepperField,
  result: HotPepperFieldResult<T>,
  policy: HotPepperFieldPolicy,
  use: HotPepperPolicyUse,
  mode: HotPepperRuntimeMode,
): HotPepperFieldResult<T> =>
  result.status !== 'known' || hotPepperPolicyAllows(policy, field, use, mode)
    ? result
    : policyWithheld<T>(field);

const supplementFor = (
  candidate: HotPepperCandidateReference,
  match: ReturnType<typeof matchHotPepperShop>,
  policy: HotPepperFieldPolicy,
  use: HotPepperPolicyUse,
  mode: HotPepperRuntimeMode,
): HotPepperSupplement | HotPepperAdapterResult => {
  if (!hotPepperPolicyAllows(policy, 'source', 'attribution', mode)) {
    return {
      status: 'unsupported',
      reason: 'Hot Pepper attribution is withheld by provider policy',
    };
  }
  const source = hotPepperSourceFor(match.shop);
  return {
    candidateId: candidate.candidateId,
    match: {
      recordRef: source.recordRef,
      distanceMeters: match.distanceMeters,
      nameSimilarity: match.nameSimilarity,
    },
    source: {
      provider: HOT_PEPPER_PROVIDER,
      recordRef: source.recordRef,
      attribution: 'ホットペッパー',
      publicUrl: source.publicUrl,
    },
    openingHours: projectField(
      'opening_hours',
      normalizeHotPepperOpeningHours(match.shop),
      policy,
      use,
      mode,
    ),
    price: projectField('price', normalizeHotPepperPrice(match.shop), policy, use, mode),
    facilities: projectField(
      'facilities',
      normalizeHotPepperFacilities(match.shop),
      policy,
      use,
      mode,
    ),
  };
};

const readWith = async (
  options: Required<Pick<HotPepperAdapterOptions, 'policy' | 'providerInputPolicy' | 'mode'>> &
    HotPepperAdapterOptions,
  candidate: HotPepperCandidateReference,
  use: HotPepperPolicyUse,
  signal: AbortSignal | undefined,
): Promise<HotPepperAdapterResult> => {
  const parsed = v.safeParse(HotPepperCandidateReferenceSchema, candidate);
  if (!parsed.success) return { status: 'error', error: new HotPepperError('INVALID_REQUEST') };
  let inputAllowed = false;
  try {
    inputAllowed = hotPepperPolicyRecordAllows(options.providerInputPolicy(), options.mode);
  } catch {
    inputAllowed = false;
  }
  if (!inputAllowed) {
    return {
      status: 'unsupported',
      reason: 'Hot Pepper lookup input is withheld by provider policy',
    };
  }
  try {
    const page = await options.transport.search(
      {
        keyword: parsed.output.name,
        lat: parsed.output.lat,
        lng: parsed.output.lng,
        range: 1,
        count: 10,
      },
      signal,
    );
    const match = matchHotPepperShop(parsed.output, page.shops, options.matchPolicy);
    const supplement = supplementFor(parsed.output, match, options.policy, use, options.mode);
    return 'status' in supplement ? supplement : { status: 'ok', value: supplement };
  } catch (error: unknown) {
    return {
      status: 'error',
      error: error instanceof HotPepperError ? error : new HotPepperError('UPSTREAM_UNAVAILABLE'),
    };
  }
};

export const createHotPepperAdapter = (inputOptions: HotPepperAdapterOptions): HotPepperAdapter => {
  const options = {
    ...inputOptions,
    policy: inputOptions.policy ?? denyHotPepperFieldPolicy,
    providerInputPolicy: inputOptions.providerInputPolicy ?? denyHotPepperProviderInputPolicy,
    mode: inputOptions.mode ?? 'live',
  };
  return {
    provider: HOT_PEPPER_PROVIDER,
    mode: options.mode,
    read: (candidate, use = 'display', signal) => readWith(options, candidate, use, signal),
  };
};

export type HotPepperEnvironment = {
  readonly IMA_RUNTIME_MODE?: unknown;
  readonly IMA_PROVIDER_HOTPEPPER?: unknown;
  readonly IMA_KILL_SWITCH?: unknown;
  readonly HOTPEPPER_API_KEY?: unknown;
};

export type ConfiguredHotPepperAdapterOptions = Omit<
  HotPepperAdapterOptions,
  'transport' | 'mode'
> &
  Pick<HotPepperTransportOptions, 'fetcher' | 'timeoutMs' | 'observer'> & {
    readonly transport?: HotPepperTransport;
  };

const operationalModeFor = (environment: HotPepperEnvironment): OperationalMode =>
  operationalCapabilityMode(resolveOperationalFlags(environment), 'hotpepper');

/**
 * Builds HP only when operational flags and credentials permit it. Fixture mode requires
 * an explicitly injected transport, so a development flag can never cause real network I/O.
 */
export const createConfiguredHotPepperAdapter = (
  environment: HotPepperEnvironment,
  options: ConfiguredHotPepperAdapterOptions = {},
): HotPepperAdapter | undefined => {
  const operationalMode = operationalModeFor(environment);
  if (operationalMode === 'disabled') return undefined;
  if (operationalMode === 'fixture') {
    if (options.transport === undefined) return undefined;
    return createHotPepperAdapter({
      ...options,
      transport: options.transport,
      mode: 'fixture',
    });
  }

  const apiKey =
    typeof environment.HOTPEPPER_API_KEY === 'string'
      ? environment.HOTPEPPER_API_KEY.trim()
      : undefined;
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  const transport = options.transport ?? createHotPepperTransport({ apiKey, ...options });
  return createHotPepperAdapter({ ...options, transport, mode: 'live' });
};
