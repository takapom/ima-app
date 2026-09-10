import type { ModelContextFieldPolicy, RetentionMetadata } from '@ima/core';
import type {
  RuntimeModelGuardCallOptions,
  RuntimeModelGuardModel,
  RuntimeModelGuardStreamPart,
} from './runtime-model-guard';
import { createPhotoBodyHandler } from '../providers/photo/http';
import { PhotoProviderError, type PhotoMediaTransport } from '../providers/photo/media';
import { createPhotoReferenceStoreResolver, type PhotoReferenceRpc } from '../providers/photo/rpc';
import { createPhotoTokenCodec } from '../providers/photo/token';
import type { PhotoBodyHandler } from '../http/handler';
import type { RuntimeFieldUsePolicy } from './runtime-field-policy';
import {
  sessionExpiryAt,
  type ProductionObservationPolicyInput,
  type ProductionRetentionSource,
} from './runtime-production-support';
import type { RuntimeProductionOverrides } from './runtime-production-types';

export const DEV_FIXTURE_PLACES_KEY = 'dev-fixture-places-key';
export const DEV_FIXTURE_CURSOR_SECRET = 'dev-fixture-cursor-secret';
export const DEV_FIXTURE_PLACE_ID = 'dev-fixture-place';
export const DEV_FIXTURE_PHOTO_REF = 'places/dev-fixture-place/photos/dev-fixture-photo';
/** Used only by the exact keyless development fixture graph; never read from live env. */
export const DEV_FIXTURE_PHOTO_TOKEN_SECRET = 'dev-fixture-photo-token-secret-v1';

const DEV_FIXTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const configured = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const text = (env: Record<string, unknown>, name: string): string | undefined => {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : undefined;
};

/** Keyless graph activation is deliberately narrower than the normal fixture flag. */
export const isKeylessDevFixtureEnvironment = (env: unknown): boolean => {
  if (!isRecord(env)) return false;
  const killSwitch = text(env, 'IMA_KILL_SWITCH');
  if (
    text(env, 'IMA_ENV') !== 'dev' ||
    text(env, 'IMA_RUNTIME_MODE') !== 'fixture' ||
    (killSwitch !== undefined && !['0', 'false', 'off', 'disabled'].includes(killSwitch))
  ) {
    return false;
  }
  return [
    'OPENAI_API_KEY',
    'GOOGLE_PLACES_API_KEY',
    'PLACES_CURSOR_SECRET',
    'GOOGLE_ROUTES_API_KEY',
    'PHOTO_TOKEN_SECRET',
  ].every((name) => !configured(env[name]));
};

/** Enables only the fixture capabilities; no live provider setting is copied into this graph. */
export const devFixtureEnvironmentFor = (env: unknown): Record<string, unknown> => {
  if (!isRecord(env)) return {};
  return {
    ...env,
    ...(env.IMA_PROVIDER_OPENAI === undefined ? { IMA_PROVIDER_OPENAI: 'true' } : {}),
    ...(env.IMA_PROVIDER_PLACES === undefined ? { IMA_PROVIDER_PLACES: 'true' } : {}),
    ...(env.IMA_PROVIDER_ROUTES === undefined ? { IMA_PROVIDER_ROUTES: 'false' } : {}),
    ...(env.IMA_PROVIDER_LAST_TRAIN === undefined ? { IMA_PROVIDER_LAST_TRAIN: 'false' } : {}),
    ...(env.IMA_PROVIDER_HOTPEPPER === undefined ? { IMA_PROVIDER_HOTPEPPER: 'false' } : {}),
  };
};

const retentionAt = (now: string): RetentionMetadata => {
  const sessionExpiresAt = sessionExpiryAt(now);
  return {
    retentionDecision: 'allow',
    retentionMode: 'provider_limited',
    sessionExpiresAt,
    freshUntil: sessionExpiresAt,
    displayUntil: sessionExpiresAt,
    retentionUntil: sessionExpiresAt,
    deletionScheduledAt: sessionExpiresAt,
    attribution: null,
    restoreMode: 'full',
    policyStatus: 'available',
    displayPolicyStatus: 'available',
  };
};

const observationPolicy = (input: ProductionObservationPolicyInput) => {
  const retention = retentionAt(input.now);
  return {
    freshUntil: retention.freshUntil ?? retention.sessionExpiresAt,
    expiresAt: retention.sessionExpiresAt,
    retention,
  };
};

const modelContextFieldPolicy: ModelContextFieldPolicy = {
  evidence: {
    identity: 'allow',
    opening_hours: 'allow',
    price: 'allow',
    photos: 'allow',
    contact: 'deny',
    facilities: 'deny',
    walking_route: 'deny',
    last_train: 'deny',
  },
  history: 'deny',
  cardSet: 'deny',
  displayName: 'deny',
};

const fixturePhotoPolicyRecord: RuntimeFieldUsePolicy['display'] = {
  decision: 'allow',
  activation: 'fixture_only',
  fieldStatus: 'known',
  policyStatus: 'available',
};

const fixturePhotoDisplayPolicy = (): {
  readonly policy: RuntimeFieldUsePolicy;
  readonly mode: 'fixture';
} => ({
  policy: {
    llm_input: fixturePhotoPolicyRecord,
    display: fixturePhotoPolicyRecord,
    persistence: fixturePhotoPolicyRecord,
  },
  mode: 'fixture',
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

const streamOf = (
  parts: readonly RuntimeModelGuardStreamPart[],
): ReadableStream<RuntimeModelGuardStreamPart> =>
  new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });

const idsInPrompt = (prompt: unknown, key: 'candidateId' | 'observationId'): string[] => {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  const visitJson = (value: unknown, depth: number): void => {
    if (depth > 12) return;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
      try {
        visitJson(JSON.parse(trimmed) as unknown, depth + 1);
      } catch {
        // Provider text is not an ID source unless it is a structured JSON envelope.
      }
      return;
    }
    if (!isRecord(value) && !Array.isArray(value)) return;
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return;
      seen.add(value);
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visitJson(item, depth + 1));
      return;
    }
    const id = value[key];
    if (typeof id === 'string' && id.length > 0) ids.add(id);
    Object.values(value).forEach((item) => visitJson(item, depth + 1));
  };
  const visitToolResults = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visitToolResults);
      return;
    }
    if (!isRecord(value)) return;
    if (value.role === 'tool') {
      visitJson(value.content, 0);
      return;
    }
    if (value.type === 'tool-result') {
      visitJson(value.output, 0);
      return;
    }
    Object.values(value).forEach(visitToolResults);
  };
  visitToolResults(prompt);
  return [...ids];
};

const containsStructuredField = (value: unknown, field: string, depth = 0): boolean => {
  if (depth > 12) return false;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    try {
      return containsStructuredField(JSON.parse(trimmed) as unknown, field, depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value))
    return value.some((item) => containsStructuredField(item, field, depth + 1));
  if (!isRecord(value)) return false;
  if (value.field === field) return true;
  return Object.values(value).some((item) => containsStructuredField(item, field, depth + 1));
};

const toolHasStructuredField = (value: unknown, field: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => toolHasStructuredField(item, field));
  if (!isRecord(value)) return false;
  if (value.role === 'user' || value.role === 'system') return false;
  if (value.role === 'tool') {
    return containsStructuredField(value.content, field);
  }
  if (value.type === 'tool-result') return containsStructuredField(value.output, field);
  if (value.type === 'tool-call' || value.type === 'text') return false;
  if (value.role === 'assistant') return toolHasStructuredField(value.content, field);
  return Object.values(value).some((item) => toolHasStructuredField(item, field));
};

const toolHasName = (value: unknown, name: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => toolHasName(item, name));
  if (!isRecord(value)) return false;
  if (value.role === 'user' || value.role === 'system') return false;
  if (
    (value.role === 'tool' || value.type === 'tool-call' || value.type === 'tool-result') &&
    value.toolName === name
  ) {
    return true;
  }
  if (value.type === 'text') return false;
  if (value.role === 'assistant' || value.role === 'tool') {
    return toolHasName(value.content, name);
  }
  return Object.values(value).some((item) => toolHasName(item, name));
};

const envelope = (input: unknown): string => JSON.stringify({ input, metadata: {} });

const toolParts = (
  call: number,
  toolName: string,
  input: unknown,
): RuntimeModelGuardStreamPart[] => {
  const id = `dev-fixture-${toolName}-${call}`;
  const encoded = envelope(input);
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: encoded },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: encoded },
    {
      type: 'finish',
      usage,
      finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    },
  ];
};

const nextTool = (prompt: unknown): { readonly name: string; readonly input: unknown } => {
  const candidates = [...new Set(idsInPrompt(prompt, 'candidateId'))];
  const observations = [...new Set(idsInPrompt(prompt, 'observationId'))];
  if (candidates.length === 0) {
    return {
      name: 'search_places',
      input: {
        mode: 'search',
        query: 'dev fixture cafe',
        area: { kind: 'named_area', name: '開発用Fixture' },
        openNow: true,
        limit: 1,
        excludeCandidateIds: [],
      },
    };
  }
  const candidateId = candidates.at(-1) ?? 'missing-candidate';
  const hasPhotoObservation = toolHasStructuredField(prompt, 'photos');
  const detailsRequested = toolHasName(prompt, 'get_place_details');
  if (
    !detailsRequested &&
    (observations.length === 0 || (toolHasName(prompt, 'search_places') && !hasPhotoObservation))
  ) {
    return {
      name: 'get_place_details',
      input: {
        requests: [{ candidateId, fields: ['identity', 'opening_hours', 'photos'] }],
        freshness: 'refresh',
      },
    };
  }
  return {
    name: 'submit_cards',
    input: {
      message: [
        { text: '開発用Fixtureの候補です。', evidenceIds: observations, basis: 'grounded' },
      ],
      hero: {
        candidateId,
        evidenceIds: observations,
        why: {
          text: 'Fixture provider の根拠を確認しました。',
          evidenceIds: observations,
          basis: 'grounded',
        },
      },
      alts: [],
    },
  };
};

export const createDevFixtureModel = (): RuntimeModelGuardModel => {
  let calls = 0;
  return {
    specificationVersion: 'v3',
    provider: 'ima-dev-fixture',
    modelId: 'dev-fixture-v1',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('DEV_FIXTURE_STREAM_ONLY')),
    doStream: (options: RuntimeModelGuardCallOptions) => {
      const step = nextTool(options.prompt);
      calls += 1;
      return Promise.resolve({ stream: streamOf(toolParts(calls, step.name, step.input)) });
    },
  };
};

const fixturePlace = (clock: () => string): Record<string, unknown> => {
  const now = Date.parse(clock());
  if (!Number.isFinite(now)) throw new Error('DEV_FIXTURE_CLOCK_INVALID');
  return {
    id: DEV_FIXTURE_PLACE_ID,
    displayName: { text: '開発用Fixture Cafe' },
    formattedAddress: '開発用Fixture',
    primaryType: 'cafe',
    businessStatus: 'OPERATIONAL',
    googleMapsUri: 'https://maps.google.com/?cid=dev-fixture',
    priceLevel: 'PRICE_LEVEL_MODERATE',
    photos: [
      {
        name: DEV_FIXTURE_PHOTO_REF,
        widthPx: 1,
        heightPx: 1,
        googleMapsUri: 'https://maps.google.com/?cid=dev-fixture&photo=1',
        authorAttributions: [{ displayName: 'Ima dev fixture' }],
      },
    ],
    currentOpeningHours: {
      periods: [{ open: { day: 0, hour: 0, minute: 0 } }],
      weekdayDescriptions: ['開発用Fixtureは終日営業'],
      openNow: true,
    },
    timeZone: { id: 'Asia/Tokyo' },
    attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com' }],
  };
};

const fixturePng = (): Uint8Array => {
  const binary = atob(DEV_FIXTURE_PNG_BASE64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const fixturePhotoTransport: PhotoMediaTransport = {
  read(photoRef, signal) {
    if (signal?.aborted === true) {
      return Promise.reject(new PhotoProviderError('CANCELLED'));
    }
    if (photoRef !== DEV_FIXTURE_PHOTO_REF) {
      return Promise.reject(new PhotoProviderError('UPSTREAM_UNAVAILABLE'));
    }
    const body = fixturePng();
    return Promise.resolve({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      contentType: 'image/png' as const,
      contentLength: body.byteLength,
    });
  },
};

/**
 * Synthetic photo serving is available only when bootstrap has already proven the exact
 * keyless dev fixture environment. It still uses the production token/reference boundary.
 */
export const createDevFixturePhotoBodyHandler = (
  resolveThread: (id: string) => PhotoReferenceRpc,
): PhotoBodyHandler =>
  createPhotoBodyHandler({
    tokenCodec: createPhotoTokenCodec({
      secret: DEV_FIXTURE_PHOTO_TOKEN_SECRET,
      referenceResolver: createPhotoReferenceStoreResolver(resolveThread),
    }),
    transport: fixturePhotoTransport,
  });

export const createDevFixtureFetcher =
  (clock: () => string = () => new Date().toISOString()): typeof fetch =>
  (input, init) => {
    if (init?.signal?.aborted === true) return Promise.reject(new Error('DEV_FIXTURE_ABORTED'));
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      request.method === 'POST' &&
      url.origin === 'https://places.googleapis.com' &&
      url.pathname === '/v1/places:searchText' &&
      url.search === ''
    ) {
      return Promise.resolve(Response.json({ places: [fixturePlace(clock)] }));
    }
    if (
      request.method === 'GET' &&
      url.origin === 'https://places.googleapis.com' &&
      url.pathname === `/v1/places/${DEV_FIXTURE_PLACE_ID}` &&
      url.search === ''
    ) {
      return Promise.resolve(Response.json(fixturePlace(clock)));
    }
    return Promise.resolve(
      Response.json({ error: 'DEV_FIXTURE_ENDPOINT_NOT_FOUND' }, { status: 404 }),
    );
  };

export const devFixtureOverridesFor = (
  overrides: RuntimeProductionOverrides,
): RuntimeProductionOverrides => {
  const clock = overrides.clock ?? (() => new Date().toISOString());
  return {
    ...overrides,
    modelForTurn: overrides.modelForTurn ?? createDevFixtureModel(),
    fetcher: overrides.fetcher ?? createDevFixtureFetcher(clock),
    googlePlacesApiKey: overrides.googlePlacesApiKey ?? DEV_FIXTURE_PLACES_KEY,
    placesCursorSecret: overrides.placesCursorSecret ?? DEV_FIXTURE_CURSOR_SECRET,
    placesEnabled: overrides.placesEnabled ?? true,
    routesEnabled: overrides.routesEnabled ?? false,
    lastTrainEnabled: overrides.lastTrainEnabled ?? false,
    photosEnabled: overrides.photosEnabled ?? true,
    photoTokenSecret: overrides.photoTokenSecret ?? DEV_FIXTURE_PHOTO_TOKEN_SECRET,
    photoDisplayPolicyFor: overrides.photoDisplayPolicyFor ?? fixturePhotoDisplayPolicy,
    observationPolicy: overrides.observationPolicy ?? observationPolicy,
    detailsObservationPolicy: overrides.detailsObservationPolicy ?? observationPolicy,
    retention:
      overrides.retention ?? ((() => retentionAt(clock())) satisfies ProductionRetentionSource),
    modelContextFieldPolicy: overrides.modelContextFieldPolicy ?? modelContextFieldPolicy,
  };
};
