import { env, SELF } from 'cloudflare:test';
import {
  CreateThreadResponseSchema,
  ErrorResponseSchema,
  SearchResponseSchema,
  type ThreadTurnRequest,
} from '@ima/contracts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { OPENAI_MODEL_NAME } from '@worker/adapters/out/providers/openai/provider-config';
import { place } from '../adapters/outbound/providers/hot-pepper/adapter-fixtures';
import { requestInput } from '../composition/runtime-production-factory-fixtures';
import { withDevCors } from '../../tooling/dev/cors';

const ORIGIN = 'http://localhost:8081';
const PHOTO_URL = 'https://imgfp.hotp.jp/IMGH/00/01/P000000001/P000000001_480.jpg';
const PHOTO_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const modelConfigured = 'OPENAI_API_KEY' in env && env.OPENAI_API_KEY === 'dev-llm-test-key';
const requestHeaders = (requestId: string) => ({
  'content-type': 'application/json',
  'x-app-token': 'dev-fixture-app-token',
  'x-device-id': 'dev-llm-test-device',
  'x-ima-owner-credential': `${'A'.repeat(42)}E`,
  'x-ima-request-id': requestId,
  'x-app-version': 'dev-llm-test',
  Origin: ORIGIN,
});

const createThread = async (): Promise<string> => {
  const requestId = crypto.randomUUID();
  const response = await SELF.fetch('https://ima.dev/v1/threads', {
    method: 'POST',
    headers: requestHeaders(requestId),
    body: JSON.stringify({ schemaVersion: 'v1', requestId, idempotencyKey: requestId }),
  });
  expect(response.status).toBe(201);
  return v.parse(CreateThreadResponseSchema, await response.json()).threadId;
};

const search = (threadId: string, changes: Partial<ThreadTurnRequest> = {}): Promise<Response> => {
  const requestId = crypto.randomUUID();
  return SELF.fetch(
    changes.revision === undefined
      ? 'https://ima.dev/v1/search'
      : `https://ima.dev/v1/threads/${threadId}/turns`,
    {
      method: 'POST',
      headers: requestHeaders(requestId),
      body: JSON.stringify({
        ...requestInput,
        ...(changes.revision === undefined ? { threadId } : {}),
        requestId,
        turnId: null,
        text: '恵比寿のカフェを探して',
        clientNow: new Date().toISOString(),
        idempotencyKey: requestId,
        ...changes,
      }),
    },
  );
};

const OpenAIRequestSchema = v.object({
  model: v.literal(OPENAI_MODEL_NAME),
  stream: v.literal(true),
  store: v.literal(false),
  input: v.array(
    v.looseObject({ call_id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))) }),
  ),
});

/** Exercise the real Responses adapter; only the upstream SSE response is synthetic. */
const openAIResponse = async (
  request: Request,
  invalidInput = false,
): Promise<{ response: Response; tool: string }> => {
  const body = v.parse(OpenAIRequestSchema, await request.json());
  const toolResults = body.input.filter((item) => item.type === 'function_call_output');
  for (const result of toolResults) {
    expect(
      body.input.filter((item) => item.type === 'function_call' && item.call_id === result.call_id),
    ).toHaveLength(1);
  }
  const candidate = v.object({ candidateId: v.string() });
  const resultSchema = v.object({
    data: v.union([
      v.object({ candidates: v.array(candidate) }),
      v.object({ items: v.array(candidate) }),
    ]),
  });
  // Earlier tool results may be retention-redacted; use the latest full result.
  const candidates = toolResults.flatMap((result) => {
    if (typeof result.output !== 'string' || !result.output.startsWith('{')) return [];
    const parsed = v.safeParse(resultSchema, JSON.parse(result.output));
    if (!parsed.success) return [];
    const data = parsed.output.data;
    return 'candidates' in data ? data.candidates : data.items;
  });
  const candidateId = candidates.at(-1)?.candidateId;
  const detailsRead = toolResults.some(
    (result) =>
      body.input.find((call) => call.call_id === result.call_id)?.name === 'get_place_details',
  );
  const tool =
    candidateId === undefined ? 'search_places' : detailsRead ? 'respond' : 'get_place_details';
  const input =
    candidateId === undefined
      ? {
          mode: 'search',
          query: 'カフェ',
          area: { kind: 'named_area', name: '恵比寿' },
          limit: 1,
          excludeCandidateIds: [],
        }
      : detailsRead
        ? {
            kind: 'propose',
            message: ['掲載情報を確認してください。'],
            hero: { candidateId, why: '検索した候補です。' },
            alts: [],
          }
        : {
            requests: [{ candidateId, fields: ['identity', 'opening_hours', 'price', 'photos'] }],
            freshness: 'refresh',
          };
  const argumentsJson = JSON.stringify(invalidInput ? {} : { input });
  const item = {
    type: 'function_call',
    id: `fc_${crypto.randomUUID()}`,
    call_id: crypto.randomUUID(),
    name: tool,
    arguments: argumentsJson,
    status: 'completed',
  };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: argumentsJson },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 10 } } },
  ];
  return {
    tool,
    response: new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    }),
  };
};

describe('development HTTP with OpenAI and Hot Pepper transports', () => {
  it.runIf(modelConfigured).each([false, true])(
    'returns cards and follows up with bounded, matching call IDs (initial invalid input: %s)',
    async (invalidInput) => {
      const tools: string[] = [];
      const modelInputs: string[] = [];
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin === 'https://webservice.recruit.co.jp') {
          expect(url.pathname).toBe('/hotpepper/gourmet/v1/');
          expect(url.searchParams.get('key')).toBe('dev-hotpepper-test-key');
          return Response.json({
            results: {
              results_available: 1,
              results_start: 1,
              shop: [
                {
                  ...place('dev-http-shop'),
                  photo: { pc: { l: PHOTO_URL } },
                },
              ],
            },
          });
        }
        if (request.url === PHOTO_URL) {
          expect(request.headers.has('authorization')).toBe(false);
          return new Response(PHOTO_BYTES, { headers: { 'content-type': 'image/png' } });
        }
        expect(request.url).toBe('https://api.openai.com/v1/responses');
        expect(request.headers.get('authorization')).toBe('Bearer dev-llm-test-key');
        modelInputs.push(await request.clone().text());
        if (invalidInput && modelInputs.length === 2) {
          const retry = v.parse(OpenAIRequestSchema, await request.clone().json());
          expect(retry.input.find((item) => item.type === 'function_call_output')?.output).toBe(
            'Tool input validation failed. Invalid fields: input',
          );
        }
        const result = await openAIResponse(request, invalidInput && modelInputs.length === 1);
        tools.push(result.tool);
        return result.response;
      });
      vi.stubGlobal('fetch', upstream);
      const threadId = await createThread();
      const response = await search(threadId);
      const body: unknown = await response.json();
      expect(
        response.status,
        JSON.stringify({ body, tools, requests: upstream.mock.calls.length }),
      ).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      const parsed = v.parse(SearchResponseSchema, body);
      expect(parsed.response.kind).toBe('cards');
      if (parsed.response.kind !== 'cards') throw new Error('TEST_CARDS_MISSING');
      expect(parsed.response.cards.hero.facts.identity).toMatchObject({
        status: 'known',
        value: { name: '店 dev-http-shop' },
      });
      const identity = parsed.response.cards.hero.facts.identity;
      if (identity.status !== 'known') throw new Error('Identity is unavailable');
      expect(identity.evidence.flatMap((item) => item.attributions ?? [])).toContainEqual({
        label: 'Powered by ホットペッパーグルメ Webサービス',
        sourceLink: 'https://webservice.recruit.co.jp/',
      });
      const photos = parsed.response.cards.hero.facts.photos;
      expect(photos?.status).toBe('known');
      if (photos?.status !== 'known') throw new Error('TEST_PHOTOS_MISSING');
      expect(photos.value.photos).toHaveLength(1);
      expect(photos.value.photos[0]?.attributions).toContainEqual({
        displayName: 'ホットペッパー グルメ',
        uri: 'https://www.hotpepper.jp/strdev-http-shop/',
      });
      expect(JSON.stringify(body)).not.toContain(PHOTO_URL);
      expect(tools).toContain('search_places');
      expect(tools).toContain('get_place_details');
      expect(tools.filter((tool) => tool === 'respond')).toHaveLength(1);
      expect(upstream).toHaveBeenCalledTimes(tools.length + 2);
      const photoUrl = `https://ima.dev/v1/photos/${photos.value.photos[0]?.photoToken}`;
      const image = await SELF.fetch(photoUrl, { headers: requestHeaders(crypto.randomUUID()) });
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/png');
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(PHOTO_BYTES);
      const imageCalls = upstream.mock.calls.length;
      const denied = await SELF.fetch(photoUrl, {
        headers: { ...requestHeaders(crypto.randomUUID()), 'x-device-id': 'another-device' },
      });
      expect(denied.status).toBe(403);
      expect(upstream).toHaveBeenCalledTimes(imageCalls);

      const firstCallCount = modelInputs.length;
      const followup = await search(threadId, {
        revision: parsed.response.revision,
        text: '予算を抑えて探し直して',
        prefs: { ...requestInput.prefs, budget: 'cheap' },
        cardSetId: parsed.response.cardSetId,
        promotedCandidateId: parsed.response.cards.hero.candidateId,
        selectedCandidateId: parsed.response.cards.hero.candidateId,
        candidateOrder: [parsed.response.cards.hero.candidateId],
      });
      const followupBody: unknown = await followup.json();
      expect(followup.status, JSON.stringify(followupBody)).toBe(200);
      expect(v.parse(SearchResponseSchema, followupBody).response.kind).toBe('cards');
      const followupInputs = modelInputs.slice(firstCallCount).join('\n');
      expect(followupInputs).toContain('予算を抑えて探し直して');
      expect(followupInputs).toContain(parsed.response.cardSetId);
    },
  );

  it.runIf(modelConfigured)(
    'returns an API failure instead of falling back to a fixed model after OpenAI rejects the key',
    async () => {
      const warn = vi.spyOn(console, 'warn');
      const upstream = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json(
            {
              error: {
                message: 'Invalid API key',
                type: 'invalid_request_error',
                code: 'invalid_api_key',
              },
            },
            { status: 401 },
          ),
        ),
      );
      vi.stubGlobal('fetch', upstream);
      const response = await search(await createThread());
      expect(response.status).toBe(502);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      const error = v.parse(ErrorResponseSchema, await response.json());
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(upstream).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'runtime_upstream_failure',
          stage: 'model',
          kind: 'execution_error',
          status: 401,
          code: 'invalid_api_key',
        }),
      );
    },
  );

  it.runIf(!modelConfigured)(
    'returns an unavailable turn without calling OpenAI when the key is missing',
    async () => {
      const response = await search(await createThread());
      expect(response.status).toBe(502);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      expect(v.parse(ErrorResponseSchema, await response.json()).code).toBe('PROVIDER_UNAVAILABLE');
    },
  );

  it('allows localhost preflight for live model mode and rejects other origins', async () => {
    for (const [origin, status] of [
      [ORIGIN, 204],
      ['https://example.com', 403],
    ] as const) {
      const response = await SELF.fetch('https://ima.dev/v1/threads', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,x-app-token,x-ima-owner-credential',
        },
      });
      expect(response.status).toBe(status);
    }
  });

  it.each(['staging', 'production'])(
    'does not enable the development profile or CORS in %s',
    async (environment) => {
      const env = { IMA_ENV: environment, IMA_RUNTIME_MODE: 'live' };
      const response = await withDevCors(
        new Request('https://ima.dev/health', {
          headers: { Origin: ORIGIN },
        }),
        env,
        () => Response.json({ status: 'ok' }),
      );
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    },
  );
});
