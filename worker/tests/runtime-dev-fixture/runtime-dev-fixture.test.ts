import { SELF } from 'cloudflare:test';
import {
  CreateThreadResponseSchema,
  SearchResponseSchema,
  type ThreadTurnRequest,
} from '@ima/contracts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { createRuntimeProductionConnectionOptions } from '@worker/composition/runtime-production-factory';
import {
  createDevFixtureFetcher,
  devFixtureEnvironmentFor,
  DEV_FIXTURE_PLACE_ID,
  isKeylessDevFixtureEnvironment,
} from '@worker/composition/runtime-dev-fixture';
import { readOnlyCommit } from '../composition/runtime-production-factory-fixtures';
import { toolCallInput } from './runtime-dev-fixture-test-support';

const OWNER_CREDENTIAL = `${'A'.repeat(42)}E`;
const NOW = '2026-09-11T03:00:00.000Z';
const PHOTO_DEVICE_ID = 'dev-fixture-device';
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

const turnInput = (requestId: string): ThreadTurnRequest => ({
  schemaVersion: 'v1',
  requestId,
  turnId: null,
  revision: 1,
  text: '恵比寿で24時間営業のカフェを探して',
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
    areaText: '恵比寿',
    budget: 'normal',
  },
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: `dev-fixture-turn-${requestId}`,
});

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
    expect(defaults.IMA_PROVIDER_HOTPEPPER).toBe('true');
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

  it('serves only the Hot Pepper fixture endpoint', async () => {
    const fetcher = createDevFixtureFetcher(() => NOW);
    const result = await fetcher(
      'https://webservice.recruit.co.jp/hotpepper/gourmet/v1/?keyword=カフェ',
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      results: { shop: [{ id: DEV_FIXTURE_PLACE_ID, open: '24時間営業' }] },
    });
    expect((await fetcher('https://evil.example/')).status).toBe(404);
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
      requests: [
        {
          candidateId: 'candidate-from-result',
          fields: ['identity', 'opening_hours', 'price', 'photos'],
        },
      ],
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
          fields: ['identity', 'opening_hours', 'price', 'photos'],
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
    const hero = response.output.response.cards.hero;
    expect(hero.candidateId).toBeTruthy();
    expect(hero.facts.identity.status).toBe('known');
    if (hero.facts.identity.status !== 'known')
      throw new Error('fixture identity was not returned');
    expect(hero.facts.identity.value).toMatchObject({
      name: '灯り坂ラウンジ（サンプル）',
      area: '恵比寿',
      address: '東京都渋谷区恵比寿・架空のサンプル店舗',
    });
    expect(hero.facts.price?.status).toBe('known');
    if (hero.facts.price?.status !== 'known') throw new Error('fixture price was not returned');
    expect(hero.facts.price.value.range).toBeNull();
    // The listed band (budget.name) is preferred; budget.average is free-form promotional text.
    expect(hero.facts.price.value.rawLabel).toBe('1200～2400円');
    const customerText = [
      ...response.output.response.message.map((item) => item.text),
      hero.why.text,
    ];
    expect(customerText.join(' ')).not.toMatch(/Fixture|provider|開発用/u);
  });
});
