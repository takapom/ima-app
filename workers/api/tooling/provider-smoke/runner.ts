import {
  createGoogleTextSearchTransport,
  type GoogleTextSearchTransport,
} from '../../src/providers/places-search/transport';
import { createGooglePlaceDetailsTransport } from '../../src/providers/places-details/transport';
import type { GooglePlaceDetailsTransport } from '../../src/providers/places-details/types';
import { createGoogleRouteMatrixTransport } from '../../src/providers/routes/transport';
import type { GoogleRouteMatrixTransport } from '../../src/providers/routes/types';
import {
  createGooglePhotoMediaTransport,
  type GooglePhotoMediaTransportOptions,
} from '../../src/providers/photo/transport';
import {
  SMOKE_CONFIRMATION_ENV,
  SMOKE_INPUT_ENV,
  SMOKE_KEY_ENV,
  SMOKE_PROVIDERS,
  envValue,
  isConfirmed,
  reportExitCode,
  resultFor,
  safeErrorCode,
  type JourneySmokeProbe,
  type ProviderSmokeReport,
  type SmokeEnvironment,
  type SmokePreflight,
  type SmokePreflightCheck,
  type SmokeProvider,
  type SmokeResult,
} from './contracts';

export type ProviderSmokeOptions = {
  readonly env: SmokeEnvironment;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  /** The live dataset adapter is injected by the M35/runtime validation owner. */
  readonly journeyProbe?: JourneySmokeProbe;
};

type Requirement = { readonly name: string; readonly configured: boolean };

const hasValue = (env: SmokeEnvironment, key: string): boolean => envValue(env, key) !== undefined;

const commonRequirements = (env: SmokeEnvironment): readonly Requirement[] => [
  { name: SMOKE_CONFIRMATION_ENV.live, configured: isConfirmed(env, SMOKE_CONFIRMATION_ENV.live) },
  {
    name: SMOKE_CONFIRMATION_ENV.billing,
    configured: isConfirmed(env, SMOKE_CONFIRMATION_ENV.billing),
  },
  {
    name: SMOKE_CONFIRMATION_ENV.permission,
    configured: isConfirmed(env, SMOKE_CONFIRMATION_ENV.permission),
  },
];

const requirementsFor = (
  provider: SmokeProvider,
  env: SmokeEnvironment,
  journeyProbe: JourneySmokeProbe | undefined,
): readonly Requirement[] => {
  const common = commonRequirements(env);
  switch (provider) {
    case 'places':
      return [
        ...common,
        { name: SMOKE_KEY_ENV.places, configured: hasValue(env, SMOKE_KEY_ENV.places) },
        {
          name: SMOKE_INPUT_ENV.searchQuery,
          configured: hasValue(env, SMOKE_INPUT_ENV.searchQuery),
        },
      ];
    case 'details':
      return [
        ...common,
        { name: SMOKE_KEY_ENV.places, configured: hasValue(env, SMOKE_KEY_ENV.places) },
        { name: SMOKE_INPUT_ENV.placeId, configured: hasValue(env, SMOKE_INPUT_ENV.placeId) },
      ];
    case 'routes':
      return [
        ...common,
        { name: SMOKE_KEY_ENV.routes, configured: hasValue(env, SMOKE_KEY_ENV.routes) },
        {
          name: SMOKE_INPUT_ENV.routeOriginPlaceId,
          configured: hasValue(env, SMOKE_INPUT_ENV.routeOriginPlaceId),
        },
        {
          name: SMOKE_INPUT_ENV.routeDestinationPlaceId,
          configured: hasValue(env, SMOKE_INPUT_ENV.routeDestinationPlaceId),
        },
      ];
    case 'photo':
      return [
        ...common,
        { name: SMOKE_KEY_ENV.places, configured: hasValue(env, SMOKE_KEY_ENV.places) },
        { name: SMOKE_INPUT_ENV.photoRef, configured: hasValue(env, SMOKE_INPUT_ENV.photoRef) },
      ];
    case 'journey':
      return [
        ...common,
        {
          name: 'JOURNEY_DATASET_LIVE_REF',
          configured: hasValue(env, 'JOURNEY_DATASET_LIVE_REF'),
        },
        { name: 'JOURNEY_LIVE_PROBE', configured: journeyProbe !== undefined },
      ];
  }
};

export const preflightLive = (
  env: SmokeEnvironment,
  journeyProbe?: JourneySmokeProbe,
): SmokePreflight => {
  const providerEntries = SMOKE_PROVIDERS.map((provider) => {
    const requirements = requirementsFor(provider, env, journeyProbe);
    return [
      provider,
      requirements.every((requirement) => requirement.configured) ? 'ready' : 'blocked',
    ] as const;
  });
  const providers = Object.fromEntries(providerEntries) as Readonly<
    Record<SmokeProvider, 'ready' | 'blocked'>
  >;
  const allRequirements = new Map<string, boolean>();
  for (const provider of SMOKE_PROVIDERS) {
    for (const requirement of requirementsFor(provider, env, journeyProbe)) {
      const current = allRequirements.get(requirement.name);
      allRequirements.set(
        requirement.name,
        current === undefined ? requirement.configured : current && requirement.configured,
      );
    }
  }
  const checks: readonly SmokePreflightCheck[] = [...allRequirements].map(([name, configured]) => ({
    name,
    status: configured ? 'configured' : 'missing',
  }));
  const readyCount = Object.values(providers).filter((status) => status === 'ready').length;
  return {
    status:
      readyCount === SMOKE_PROVIDERS.length ? 'ready' : readyCount === 0 ? 'blocked' : 'partial',
    checks,
    providers,
  };
};

const onlyRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class SmokeBodyError extends Error {
  readonly code: 'RESULT_TOO_LARGE' | 'SMOKE_BODY_TIMEOUT' | 'CANCELLED' | 'PREFLIGHT_BLOCKED';

  constructor(code: SmokeBodyError['code']) {
    super(code);
    this.name = 'SmokeBodyError';
    this.code = code;
  }
}

const requiredApiKey = (env: SmokeEnvironment, key: string): string => {
  const value = envValue(env, key);
  if (value === undefined) throw new SmokeBodyError('PREFLIGHT_BLOCKED');
  return value;
};

const consumePhoto = async (
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<number> => {
  const maxBytes = 8 * 1024 * 1024;
  const timeoutMs = 15_000;
  const reader = body.getReader();
  let total = 0;
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const readAll = async (): Promise<number> => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        completed = true;
        return total;
      }
      if (!(chunk.value instanceof Uint8Array)) throw new SmokeBodyError('RESULT_TOO_LARGE');
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new SmokeBodyError('RESULT_TOO_LARGE');
    }
  };
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SmokeBodyError('SMOKE_BODY_TIMEOUT')), timeoutMs);
  });
  let removeAbort = (): void => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(new SmokeBodyError('CANCELLED'));
    removeAbort = (): void => signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([readAll(), deadline, cancellation]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbort();
    if (!completed) {
      void reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
};

const runPlaces = async (
  env: SmokeEnvironment,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<SmokeResult> => {
  const apiKey = requiredApiKey(env, SMOKE_KEY_ENV.places);
  const transport: GoogleTextSearchTransport = createGoogleTextSearchTransport({
    apiKey,
    fetcher,
  });
  const page = await transport.search(
    {
      textQuery: envValue(env, SMOKE_INPUT_ENV.searchQuery) ?? '',
      openNow: false,
      pageSize: 1,
    },
    signal,
  );
  return Array.isArray(page.places)
    ? resultFor(
        'places',
        'passed',
        page.places.length === 0 ? 'NO_DATA' : 'OK',
        0,
        'live',
        page.places.length === 0 ? 'no_data' : 'success',
      )
    : resultFor('places', 'failed', 'SCHEMA_MISMATCH');
};

const runDetails = async (
  env: SmokeEnvironment,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<SmokeResult> => {
  const apiKey = requiredApiKey(env, SMOKE_KEY_ENV.places);
  const transport: GooglePlaceDetailsTransport = createGooglePlaceDetailsTransport({
    apiKey,
    fetcher,
  });
  const placeId = envValue(env, SMOKE_INPUT_ENV.placeId) ?? '';
  const response = await transport.read(
    {
      placeId,
      fields: ['identity'],
    },
    signal,
  );
  const body = response.body;
  if (!onlyRecord(body) || typeof body.id !== 'string' || body.id !== placeId) {
    return resultFor('details', 'failed', 'IDENTITY_MISMATCH');
  }
  const displayName = body.displayName;
  return onlyRecord(displayName) &&
    typeof displayName.text === 'string' &&
    displayName.text.length > 0
    ? resultFor('details', 'passed', 'OK')
    : resultFor('details', 'failed', 'IDENTITY_INCOMPLETE');
};

const runRoutes = async (
  env: SmokeEnvironment,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<SmokeResult> => {
  const apiKey = requiredApiKey(env, SMOKE_KEY_ENV.routes);
  const transport: GoogleRouteMatrixTransport = createGoogleRouteMatrixTransport({
    apiKey,
    fetcher,
  });
  const response = await transport.compute(
    {
      origins: [
        { ref: 'smoke-origin', placeId: envValue(env, SMOKE_INPUT_ENV.routeOriginPlaceId) ?? '' },
      ],
      destinations: [
        {
          ref: 'smoke-destination',
          placeId: envValue(env, SMOKE_INPUT_ENV.routeDestinationPlaceId) ?? '',
        },
      ],
    },
    signal,
  );
  const element = response[0];
  if (
    response.length !== 1 ||
    element?.parseError !== undefined ||
    element?.condition === undefined
  ) {
    return resultFor('routes', 'failed', 'SCHEMA_MISMATCH');
  }
  if (element.condition === 'ROUTE_NOT_FOUND')
    return resultFor('routes', 'passed', 'NO_ROUTE', 0, 'live', 'no_data');
  const usable =
    element.condition === 'ROUTE_EXISTS' &&
    typeof element.duration === 'string' &&
    typeof element.distanceMeters === 'number';
  return usable
    ? resultFor('routes', 'passed', 'OK')
    : resultFor('routes', 'failed', 'SCHEMA_MISMATCH');
};

const runPhoto = async (
  env: SmokeEnvironment,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<SmokeResult> => {
  const apiKey = requiredApiKey(env, SMOKE_KEY_ENV.places);
  const options: GooglePhotoMediaTransportOptions = {
    apiKey,
    fetcher,
  };
  const media = await createGooglePhotoMediaTransport(options).read(
    envValue(env, SMOKE_INPUT_ENV.photoRef) ?? '',
    signal,
  );
  const bytes = await consumePhoto(media.body, signal);
  return bytes > 0
    ? resultFor('photo', 'passed', 'OK')
    : resultFor('photo', 'failed', 'EMPTY_BODY');
};

const runJourney = async (probe: JourneySmokeProbe): Promise<SmokeResult> => {
  const result = await probe();
  if (result.source !== 'live') return resultFor('journey', 'failed', 'FIXTURE_NOT_LIVE');
  return result.ok
    ? resultFor('journey', 'passed', 'OK')
    : resultFor('journey', 'failed', safeErrorCode({ code: result.code ?? 'LIVE_DATASET_FAILED' }));
};

const execute = async (
  provider: SmokeProvider,
  action: (fetcher: typeof fetch) => Promise<SmokeResult>,
  fetcher: typeof fetch,
): Promise<SmokeResult> => {
  let calls = 0;
  const countedFetcher: typeof fetch = async (input, init) => {
    calls += 1;
    return fetcher(input, init);
  };
  try {
    const result = await action(countedFetcher);
    return { ...result, calls };
  } catch (error: unknown) {
    return { ...resultFor(provider, 'failed', safeErrorCode(error)), calls };
  }
};

export const runProviderSmoke = async (
  options: ProviderSmokeOptions,
): Promise<ProviderSmokeReport> => {
  const journeyProbe = options.journeyProbe;
  const preflight = preflightLive(options.env, journeyProbe);
  const actualFetcher = options.fetcher ?? globalThis.fetch;
  const results = await Promise.all(
    SMOKE_PROVIDERS.map((provider) => {
      const journeyIsUnconfigured =
        provider === 'journey' &&
        (journeyProbe === undefined ||
          envValue(options.env, 'JOURNEY_DATASET_LIVE_REF') === undefined) &&
        commonRequirements(options.env).every((requirement) => requirement.configured);
      if (journeyIsUnconfigured) {
        return Promise.resolve(resultFor('journey', 'skipped', 'DATASET_NOT_CONFIGURED'));
      }
      if (preflight.providers[provider] === 'blocked') {
        return Promise.resolve(resultFor(provider, 'skipped', 'PREFLIGHT_BLOCKED'));
      }
      switch (provider) {
        case 'places':
          return execute(
            provider,
            (fetcher) => runPlaces(options.env, fetcher, options.signal),
            actualFetcher,
          );
        case 'details':
          return execute(
            provider,
            (fetcher) => runDetails(options.env, fetcher, options.signal),
            actualFetcher,
          );
        case 'routes':
          return execute(
            provider,
            (fetcher) => runRoutes(options.env, fetcher, options.signal),
            actualFetcher,
          );
        case 'photo':
          return execute(
            provider,
            (fetcher) => runPhoto(options.env, fetcher, options.signal),
            actualFetcher,
          );
        case 'journey':
          return journeyProbe === undefined
            ? Promise.resolve(resultFor('journey', 'skipped', 'DATASET_NOT_CONFIGURED'))
            : execute('journey', () => runJourney(journeyProbe), actualFetcher);
      }
    }),
  );
  return { mode: 'live', preflight, results, exitCode: reportExitCode(results) };
};

type ProcessLike = {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  exitCode?: number;
};

const processLike = (): ProcessLike | undefined =>
  (globalThis as typeof globalThis & { readonly process?: ProcessLike }).process;

export const runProviderSmokeCli = async (
  args: readonly string[],
  env: SmokeEnvironment,
  write: (line: string) => void = (line) => console.log(line),
): Promise<0 | 1 | 2> => {
  if (args.some((arg) => arg !== '--live' && arg !== '--json')) {
    write(JSON.stringify({ mode: 'live', status: 'failed', code: 'INVALID_ARGUMENT' }));
    return 1;
  }
  if (!args.includes('--live')) {
    write(JSON.stringify({ mode: 'live', status: 'skipped', code: 'LIVE_FLAG_REQUIRED' }));
    return 2;
  }
  const report = await runProviderSmoke({ env });
  write(JSON.stringify(report));
  return report.exitCode;
};

const main = async (): Promise<void> => {
  const process = processLike();
  const code = await runProviderSmokeCli(process?.argv?.slice(2) ?? [], process?.env ?? {});
  if (process !== undefined) process.exitCode = code;
};

if ((import.meta as ImportMeta & { readonly main?: boolean }).main === true) {
  void main().catch(() => {
    const process = processLike();
    console.log(JSON.stringify({ mode: 'live', status: 'failed', code: 'UNCLASSIFIED_ERROR' }));
    if (process !== undefined) process.exitCode = 1;
  });
}
