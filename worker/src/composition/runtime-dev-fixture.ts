import type { ModelContextFieldPolicy } from '@worker/application/model-context/model-context-policy';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import type {
  RuntimeModelGuardCallOptions,
  RuntimeModelGuardModel,
  RuntimeModelGuardStreamPart,
} from '@worker/runtime/turn-execution/runtime-model-guard';
import { HOT_PEPPER_GOURMET_ENDPOINT } from '@worker/adapters/out/providers/hot-pepper/types';
import { fixturePlace } from '@worker/composition/runtime-dev-fixture-place';
import {
  sessionExpiryAt,
  type ProductionObservationPolicyInput,
  type ProductionRetentionSource,
} from '@worker/composition/runtime-production-support';
import type { RuntimeProductionOverrides } from '@worker/composition/runtime-production-types';

export const DEV_FIXTURE_PLACES_KEY = 'dev-fixture-places-key';
export const DEV_FIXTURE_CURSOR_SECRET = 'dev-fixture-cursor-secret';
export { DEV_FIXTURE_PLACE_ID } from '@worker/composition/runtime-dev-fixture-place';
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
  return ['OPENAI_API_KEY', 'HOTPEPPER_API_KEY', 'PLACES_CURSOR_SECRET'].every(
    (name) => !configured(env[name]),
  );
};

/** Enables only the fixture capabilities; no live provider setting is copied into this graph. */
export const devFixtureEnvironmentFor = (env: unknown): Record<string, unknown> => {
  if (!isRecord(env)) return {};
  return {
    ...env,
    ...(env.IMA_PROVIDER_OPENAI === undefined ? { IMA_PROVIDER_OPENAI: 'true' } : {}),
    ...(env.IMA_PROVIDER_PLACES === undefined ? { IMA_PROVIDER_PLACES: 'false' } : {}),
    ...(env.IMA_PROVIDER_HOTPEPPER === undefined ? { IMA_PROVIDER_HOTPEPPER: 'true' } : {}),
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
    photos: 'deny',
    contact: 'deny',
    facilities: 'deny',
  },
  history: 'deny',
  cardSet: 'deny',
  displayName: 'deny',
};

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

const envelope = (input: unknown): string => JSON.stringify({ input });

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
        query: 'カフェ',
        area: { kind: 'named_area', name: '恵比寿' },
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
        requests: [
          {
            candidateId,
            fields: ['identity', 'opening_hours', 'price', 'photos'],
          },
        ],
        freshness: 'refresh',
      },
    };
  }
  return {
    name: 'submit_cards',
    input: {
      message: [
        {
          text: '掲載営業時間は24時間、予算目安は1,200〜2,400円です。現在の営業状況は未確認です。',
          evidenceIds: observations,
          basis: 'grounded',
        },
      ],
      hero: {
        candidateId,
        evidenceIds: observations,
        why: {
          text: '恵比寿のカフェ候補です。営業状況は店舗で確認してください。',
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

export const createDevFixtureFetcher =
  (clock: () => string = () => new Date().toISOString()): typeof fetch =>
  (input, init) => {
    if (init?.signal?.aborted === true) return Promise.reject(new Error('DEV_FIXTURE_ABORTED'));
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.origin + url.pathname === HOT_PEPPER_GOURMET_ENDPOINT) {
      return Promise.resolve(
        Response.json({
          results: { results_available: 1, results_start: 1, shop: [fixturePlace(clock)] },
        }),
      );
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
    hotPepperApiKey: overrides.hotPepperApiKey ?? DEV_FIXTURE_PLACES_KEY,
    placesCursorSecret: overrides.placesCursorSecret ?? DEV_FIXTURE_CURSOR_SECRET,
    placesEnabled: overrides.placesEnabled ?? true,
    observationPolicy: overrides.observationPolicy ?? observationPolicy,
    detailsObservationPolicy: overrides.detailsObservationPolicy ?? observationPolicy,
    retention:
      overrides.retention ?? ((() => retentionAt(clock())) satisfies ProductionRetentionSource),
    modelContextFieldPolicy: overrides.modelContextFieldPolicy ?? modelContextFieldPolicy,
  };
};
