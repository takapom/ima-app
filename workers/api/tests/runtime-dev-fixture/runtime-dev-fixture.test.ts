import { env, SELF } from 'cloudflare:test';
import {
  CreateThreadResponseSchema,
  ErrorResponseSchema,
  SearchResponseSchema,
  type ThreadTurnRequest,
} from '@ima/contracts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { createHttpRouterConfig, createThreadScopeAuthorizer } from '../../src/bootstrap';
import { deriveOwnerScopeRef } from '../../src/http/auth';
import { routeRequest } from '../../src/http/router';
import { createPhotoReferenceStoreResolver } from '../../src/providers/photo/rpc';
import { createPhotoTokenCodec } from '../../src/providers/photo/token';
import type { RateLimitDO, ThreadDO } from '../../src/thread-do';
import type { RuntimeModelGuardCallOptions } from '../../src/runtime/runtime-model-guard';
import { createRuntimeProductionConnectionOptions } from '../../src/runtime/runtime-production-factory';
import {
  createDevFixtureFetcher,
  createDevFixtureModel,
  devFixtureEnvironmentFor,
  DEV_FIXTURE_PHOTO_REF,
  DEV_FIXTURE_PHOTO_TOKEN_SECRET,
  DEV_FIXTURE_PLACE_ID,
  isKeylessDevFixtureEnvironment,
} from '../../src/runtime/runtime-dev-fixture';
import { readOnlyCommit } from '../runtime/runtime-production-factory-fixtures';

const OWNER_CREDENTIAL = `${'A'.repeat(42)}E`;
const NOW = '2026-09-11T03:00:00.000Z';
const PHOTO_DEVICE_ID = 'dev-fixture-device';
const fixtureBindings = env as unknown as {
  readonly THREADS: DurableObjectNamespace<ThreadDO>;
  readonly RATE_LIMITS: DurableObjectNamespace<RateLimitDO>;
};
const headers = (
  requestId: string,
  options: { readonly ownerCredential?: string; readonly deviceId?: string } = {},
): Record<string, string> => ({
  'content-type': 'application/json',
  'x-app-token': 'dev-fixture-app-token',
  'x-device-id': options.deviceId ?? PHOTO_DEVICE_ID,
  'x-ima-owner-credential': options.ownerCredential ?? OWNER_CREDENTIAL,
  'x-ima-request-id': requestId,
  'x-app-version': 'm29-dev-fixture-test',
});

const call = async (
  path: string,
  requestId: string,
  init: RequestInit = {},
  options: { readonly ownerCredential?: string; readonly deviceId?: string } = {},
): Promise<Response> => {
  const requestHeaders = new Headers(headers(requestId, options));
  new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
  return SELF.fetch(`https://ima.dev${path}`, { ...init, headers: requestHeaders });
};

const createFixtureThread = async (suffix: string): Promise<string> => {
  const requestId = `dev-fixture-photo-create-${suffix}-${crypto.randomUUID()}`;
  const response = await call('/v1/threads', requestId, {
    method: 'POST',
    body: JSON.stringify({
      schemaVersion: 'v1',
      requestId,
      idempotencyKey: `dev-fixture-photo-create-${suffix}-${crypto.randomUUID()}`,
    }),
  });
  expect(response.status).toBe(201);
  const parsed = v.safeParse(CreateThreadResponseSchema, await response.json());
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('dev fixture photo thread response was invalid');
  return parsed.output.threadId;
};

const routePhotoWithEnv = async (
  token: string,
  requestId: string,
  variables: Record<string, string>,
): Promise<Response> => {
  const request = new Request(`https://ima.dev/v1/photos/${encodeURIComponent(token)}`, {
    method: 'GET',
    headers: headers(requestId),
  });
  return routeRequest(
    request,
    createHttpRouterConfig(
      {
        ...fixtureBindings,
        APP_TOKEN: 'dev-fixture-app-token',
        IMA_ENV: 'dev',
        IMA_RUNTIME_MODE: 'fixture',
        ...variables,
      },
      { ownership: createThreadScopeAuthorizer(fixtureBindings.THREADS) },
    ),
  );
};

const turnInput = (requestId: string): ThreadTurnRequest => ({
  schemaVersion: 'v1',
  requestId,
  turnId: null,
  revision: 1,
  text: '開発用Fixtureから候補を探して',
  clientNow: NOW,
  location: {
    status: 'unavailable',
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: '開発用Fixture',
    budget: 'normal',
  },
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: `dev-fixture-turn-${requestId}`,
});

const toolCallInput = async (
  prompt: RuntimeModelGuardCallOptions['prompt'],
): Promise<Record<string, unknown>> => {
  const model = createDevFixtureModel();
  const result = await model.doStream({ prompt });
  const collected: unknown[] = [];
  await result.stream.pipeTo(
    new WritableStream({
      write(part) {
        collected.push(part);
      },
    }),
  );
  const call = collected.find(
    (part): part is { type: 'tool-call'; input: string } =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'tool-call',
  );
  if (call === undefined) throw new Error('fixture model did not emit a tool call');
  const parsed: unknown = JSON.parse(call.input);
  if (typeof parsed !== 'object' || parsed === null || !('input' in parsed)) {
    throw new Error('fixture tool call envelope was invalid');
  }
  return (parsed as { input: Record<string, unknown> }).input;
};

describe('keyless dev fixture graph', () => {
  it('requires the exact dev fixture mode and preserves explicit provider gates', () => {
    expect(isKeylessDevFixtureEnvironment({ IMA_ENV: 'dev', IMA_RUNTIME_MODE: 'fixture' })).toBe(
      true,
    );
    expect(
      isKeylessDevFixtureEnvironment({ IMA_ENV: 'staging', IMA_RUNTIME_MODE: 'fixture' }),
    ).toBe(false);
    expect(
      isKeylessDevFixtureEnvironment({
        IMA_ENV: 'dev',
        IMA_RUNTIME_MODE: 'fixture',
        IMA_KILL_SWITCH: 'true',
      }),
    ).toBe(false);
    expect(
      isKeylessDevFixtureEnvironment({
        IMA_ENV: 'dev',
        IMA_RUNTIME_MODE: 'fixture',
        OPENAI_API_KEY: 'accidental-live-key',
      }),
    ).toBe(false);

    const defaults = devFixtureEnvironmentFor({
      IMA_ENV: 'dev',
      IMA_RUNTIME_MODE: 'fixture',
    });
    expect(defaults.IMA_PROVIDER_OPENAI).toBe('true');
    expect(defaults.IMA_PROVIDER_PLACES).toBe('true');
    expect(
      devFixtureEnvironmentFor({
        IMA_ENV: 'dev',
        IMA_RUNTIME_MODE: 'fixture',
        IMA_PROVIDER_PLACES: 'false',
        IMA_PROVIDER_OPENAI: 'unknown',
      }),
    ).toMatchObject({ IMA_PROVIDER_PLACES: 'false', IMA_PROVIDER_OPENAI: 'unknown' });
  });

  it('keeps the actual factory fail-closed for live, killed, and disabled environments', () => {
    const fixtureEnv = { IMA_ENV: 'dev', IMA_RUNTIME_MODE: 'fixture' };
    expect(
      createRuntimeProductionConnectionOptions({ env: fixtureEnv, commit: readOnlyCommit }),
    ).toBeDefined();
    expect(
      createRuntimeProductionConnectionOptions({
        env: { ...fixtureEnv, IMA_PROVIDER_OPENAI: 'false' },
        commit: readOnlyCommit,
      }),
    ).toBeUndefined();
    expect(
      createRuntimeProductionConnectionOptions({
        env: { ...fixtureEnv, IMA_KILL_SWITCH: 'true' },
        commit: readOnlyCommit,
      }),
    ).toBeUndefined();
    expect(
      createRuntimeProductionConnectionOptions({
        env: { ...fixtureEnv, OPENAI_API_KEY: 'live-key' },
        commit: readOnlyCommit,
      }),
    ).toBeUndefined();
    expect(
      createRuntimeProductionConnectionOptions({
        env: { IMA_ENV: 'staging', IMA_RUNTIME_MODE: 'fixture' },
        commit: readOnlyCommit,
      }),
    ).toBeUndefined();
  });

  it('serves only fixed fixture endpoints with coherent all-day hours', async () => {
    const fetcher = createDevFixtureFetcher(() => NOW);
    const search = await fetcher('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
    });
    expect(search.status).toBe(200);
    const body: { places?: Array<Record<string, unknown>> } = await search.json();
    expect(body.places?.[0]?.id).toBe(DEV_FIXTURE_PLACE_ID);
    expect(body.places?.[0]?.currentOpeningHours).toMatchObject({ openNow: true });
    expect((body.places?.[0]?.currentOpeningHours as { periods?: unknown[] }).periods).toEqual([
      { open: { day: 0, hour: 0, minute: 0 } },
    ]);

    const details = await fetcher(
      `https://places.googleapis.com/v1/places/${DEV_FIXTURE_PLACE_ID}`,
      { method: 'GET' },
    );
    expect(details.status).toBe(200);
    await expect(
      fetcher('https://evil.example/v1/places/dev-fixture-place', { method: 'GET' }),
    ).resolves.toHaveProperty('status', 404);
    await expect(
      fetcher('https://places.googleapis.com/v1/places:searchText', { method: 'GET' }),
    ).resolves.toHaveProperty('status', 404);
  });

  it('chooses details and submit from structured tool result envelopes', async () => {
    const candidateInput = await toolCallInput([
      {
        role: 'user',
        content: [{ type: 'text', text: '{"candidateId":"spoof-from-user-text"}' }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'search-1',
            toolName: 'search_places',
            output: {
              type: 'json',
              value: { candidates: [{ candidateId: 'candidate-from-result' }] },
            },
          },
        ],
      },
    ]);
    expect(candidateInput).toMatchObject({
      requests: [{ candidateId: 'candidate-from-result' }],
    });

    const submitInput = await toolCallInput([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'search-1',
            toolName: 'search_places',
            output: {
              type: 'json',
              value: { candidates: [{ candidateId: 'candidate-from-result' }] },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'details-1',
            toolName: 'get_place_details',
            output: {
              type: 'json',
              value: JSON.stringify({
                type: 'json',
                value: {
                  candidateId: 'candidate-from-result',
                  observations: [{ observationId: 'observation-from-result' }],
                },
              }),
            },
          },
        ],
      },
    ]);
    expect(submitInput).toMatchObject({
      hero: { candidateId: 'candidate-from-result', evidenceIds: ['observation-from-result'] },
    });
  });

  it('does not treat user JSON as a photo observation', async () => {
    const input = await toolCallInput([
      {
        role: 'user',
        content: [{ type: 'text', text: '{"field":"photos"}' }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'search-2',
            toolName: 'search_places',
            output: {
              type: 'json',
              value: {
                candidates: [{ candidateId: 'candidate-from-search' }],
                observations: [{ observationId: 'observation-from-search' }],
              },
            },
          },
        ],
      },
    ]);
    expect(input).toMatchObject({
      requests: [
        {
          candidateId: 'candidate-from-search',
          fields: ['identity', 'opening_hours', 'photos', 'walking_route'],
        },
      ],
    });
  });

  it('runs the default HTTP to DO to model to provider to cards path without keys', async () => {
    const createRequestId = `dev-fixture-create-${crypto.randomUUID()}`;
    const create = await call('/v1/threads', createRequestId, {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId: createRequestId,
        idempotencyKey: `dev-fixture-create-key-${crypto.randomUUID()}`,
      }),
    });
    expect(create.status).toBe(201);
    const created = v.safeParse(CreateThreadResponseSchema, await create.json());
    expect(created.success).toBe(true);
    if (!created.success) throw new Error('dev fixture thread response was invalid');

    const turnRequestId = `dev-fixture-turn-${crypto.randomUUID()}`;
    const turn = await call(`/v1/threads/${created.output.threadId}/turns`, turnRequestId, {
      method: 'POST',
      body: JSON.stringify(turnInput(turnRequestId)),
    });
    expect(turn.status).toBe(200);
    const response = v.safeParse(SearchResponseSchema, await turn.json());
    expect(response.success).toBe(true);
    if (!response.success) throw new Error('dev fixture cards response was invalid');
    expect(response.output.response.kind).toBe('cards');
    if (response.output.response.kind !== 'cards') throw new Error('cards response was missing');
    expect(response.output.response.cards.hero.candidateId).toBeTruthy();
  });

  it('serves a token-bound fixture photo over the default HTTP entry', async () => {
    const threadId = await createFixtureThread('photo');
    const turnRequestId = `dev-fixture-photo-turn-${crypto.randomUUID()}`;
    const turn = await call(`/v1/threads/${threadId}/turns`, turnRequestId, {
      method: 'POST',
      body: JSON.stringify(turnInput(turnRequestId)),
    });
    expect(turn.status).toBe(200);
    const parsed = v.safeParse(SearchResponseSchema, await turn.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.output.response.kind !== 'cards') {
      throw new Error('dev fixture photo cards response was invalid');
    }
    const photoFact = parsed.output.response.cards.hero.facts.photos;
    expect(photoFact?.status).toBe('known');
    if (photoFact?.status !== 'known') throw new Error('dev fixture photo metadata was withheld');
    const photo = photoFact.value.photos[0];
    if (photo === undefined) throw new Error('dev fixture photo token was missing');
    expect(photo.attributions).toEqual([{ displayName: 'Ima dev fixture', uri: null }]);
    expect(photo.sourceUrl).toBe('https://maps.google.com/?cid=dev-fixture&photo=1');

    const photoRequestId = `dev-fixture-photo-read-${crypto.randomUUID()}`;
    const image = await call(`/v1/photos/${encodeURIComponent(photo.photoToken)}`, photoRequestId, {
      method: 'GET',
    });
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-ima-request-id')).toBe(photoRequestId);
    expect([...new Uint8Array(await image.arrayBuffer()).slice(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);

    const wrongOwner = await call(
      `/v1/photos/${encodeURIComponent(photo.photoToken)}`,
      `dev-fixture-photo-wrong-owner-${crypto.randomUUID()}`,
      { method: 'GET' },
      { ownerCredential: `${'B'.repeat(42)}E` },
    );
    expect(wrongOwner.status).toBe(403);

    const placesDisabled = await routePhotoWithEnv(
      photo.photoToken,
      `dev-fixture-photo-places-disabled-${crypto.randomUUID()}`,
      { IMA_PROVIDER_PLACES: 'false', IMA_KILL_SWITCH: 'false' },
    );
    expect(placesDisabled.status).toBe(404);
    const killed = await routePhotoWithEnv(
      photo.photoToken,
      `dev-fixture-photo-killed-${crypto.randomUUID()}`,
      { IMA_KILL_SWITCH: 'true' },
    );
    expect(killed.status).toBe(404);
  });
  it('returns EXPIRED for a short-lived keyless fixture token after its deadline', async () => {
    const threadId = await createFixtureThread('photo-expiry');
    const ownerScopeRef = await deriveOwnerScopeRef(OWNER_CREDENTIAL);
    if (ownerScopeRef === null) throw new Error('owner scope fixture was invalid');
    const codec = createPhotoTokenCodec({
      secret: DEV_FIXTURE_PHOTO_TOKEN_SECRET,
      ttlSeconds: 2,
      referenceResolver: createPhotoReferenceStoreResolver((id) =>
        fixtureBindings.THREADS.getByName(id),
      ),
    });
    const issueNow = new Date(Math.floor(Date.now() / 1_000) * 1_000).toISOString();
    const token = await codec.issue(
      {
        ownerScopeRef,
        threadId,
        turnId: 'dev-fixture-photo-turn',
        revision: 1,
        deviceId: PHOTO_DEVICE_ID,
        photoRef: DEV_FIXTURE_PHOTO_REF,
      },
      issueNow,
    );
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const response = await call(
      `/v1/photos/${encodeURIComponent(token)}`,
      `dev-fixture-photo-expired-${crypto.randomUUID()}`,
      { method: 'GET' },
    );
    expect(response.status).toBe(410);
    const error = v.safeParse(ErrorResponseSchema, await response.json());
    expect(error.success).toBe(true);
    if (!error.success) throw new Error('expired photo response was invalid');
    expect(error.output.code).toBe('EXPIRED');
  });
  it('does not drop a hard walking constraint when no current location is available', async () => {
    const createRequestId = `dev-fixture-constraint-create-${crypto.randomUUID()}`;
    const create = await call('/v1/threads', createRequestId, {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId: createRequestId,
        idempotencyKey: `dev-fixture-constraint-key-${crypto.randomUUID()}`,
      }),
    });
    expect(create.status).toBe(201);
    const created = v.safeParse(CreateThreadResponseSchema, await create.json());
    expect(created.success).toBe(true);
    if (!created.success) throw new Error('dev fixture constraint thread response was invalid');

    const requestId = `dev-fixture-constraint-turn-${crypto.randomUUID()}`;
    const input = turnInput(requestId);
    const constrained = {
      ...input,
      text: '徒歩15分以内で探して',
      prefs: { ...input.prefs, maxWalkMinutes: 15 },
    };
    const response = await call(`/v1/threads/${created.output.threadId}/turns`, requestId, {
      method: 'POST',
      body: JSON.stringify(constrained),
    });
    expect(response.status).toBe(502);
    const parsed = v.safeParse(ErrorResponseSchema, await response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('constraint rejection response was invalid');
    expect(parsed.output).toMatchObject({ status: 502, code: 'PROVIDER_UNAVAILABLE' });
  });
});
