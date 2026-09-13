import { env, SELF } from 'cloudflare:test';
import {
  CreateThreadResponseSchema,
  ErrorResponseSchema,
  SearchResponseSchema,
  type ThreadTurnRequest,
} from '@ima/contracts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { OPENAI_MODEL_NAME } from '../../src/model/provider-config';
import { createDevFixtureModel } from '../../src/runtime/composition/runtime-dev-fixture';
import type { RuntimeModelGuardStreamPart } from '../../src/runtime/turn-execution/runtime-model-guard';
import { requestInput } from '../runtime/composition/runtime-production-factory-fixtures';
import { withDevFixtureCors } from './runtime-dev-fixture-cors';
import { isDevLiveModelEnvironment } from './runtime-dev-llm';

const ORIGIN = 'http://localhost:8081';
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
  return SELF.fetch(`https://ima.dev/v1/threads/${threadId}/turns`, {
    method: 'POST',
    headers: requestHeaders(requestId),
    body: JSON.stringify({
      ...requestInput,
      requestId,
      turnId: null,
      text: '恵比寿のカフェを探して',
      clientNow: new Date().toISOString(),
      idempotencyKey: requestId,
      ...changes,
    }),
  });
};

const OpenAIRequestSchema = v.object({
  model: v.literal(OPENAI_MODEL_NAME),
  stream: v.literal(true),
  store: v.literal(false),
  input: v.array(v.record(v.string(), v.unknown())),
});

/** Exercise the real Responses adapter; only the upstream SSE response is synthetic. */
const openAIResponse = async (request: Request): Promise<{ response: Response; tool: string }> => {
  const body = v.parse(OpenAIRequestSchema, await request.json());
  const toolResults = body.input.filter((item) => item.type === 'function_call_output');
  const model = createDevFixtureModel();
  const result = await model.doStream({
    prompt: toolResults.map((item) => ({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: String(item.call_id),
          toolName:
            body.input.find((call) => call.call_id === item.call_id)?.name === 'get_place_details'
              ? 'get_place_details'
              : 'search_places',
          output: { type: 'text', value: String(item.output) },
        },
      ],
    })),
  });
  const parts: RuntimeModelGuardStreamPart[] = [];
  await result.stream.pipeTo(
    new WritableStream({
      write(part) {
        parts.push(part);
      },
    }),
  );
  const call = parts.find((part) => part.type === 'tool-call');
  if (call === undefined) throw new Error('TEST_TOOL_CALL_MISSING');
  const item = {
    type: 'function_call',
    id: `fc_${crypto.randomUUID()}`,
    call_id: crypto.randomUUID(),
    name: call.toolName,
    arguments: call.input,
    status: 'completed',
  };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: call.input },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 10 } } },
  ];
  return {
    tool: call.toolName,
    response: new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    }),
  };
};

describe('development HTTP with OpenAI and synthetic Places', () => {
  it.runIf(modelConfigured)(
    'uses the Responses adapter and returns validated synthetic cards through HTTP',
    async () => {
      const tools: string[] = [];
      const modelInputs: string[] = [];
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe('https://api.openai.com/v1/responses');
        expect(request.headers.get('authorization')).toBe('Bearer dev-llm-test-key');
        modelInputs.push(await request.clone().text());
        const result = await openAIResponse(request);
        tools.push(result.tool);
        return result.response;
      });
      vi.stubGlobal('fetch', upstream);
      const threadId = await createThread();
      const response = await search(threadId);
      const body: unknown = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      const parsed = v.parse(SearchResponseSchema, body);
      expect(parsed.response.kind).toBe('cards');
      if (parsed.response.kind !== 'cards') throw new Error('TEST_CARDS_MISSING');
      expect(parsed.response.cards.hero.facts.identity).toMatchObject({
        status: 'known',
        value: { name: '灯り坂ラウンジ（サンプル）' },
      });
      expect(parsed.response.cards.hero.facts.photos?.status).not.toBe('known');
      expect(parsed.response.cards.hero.facts.walking_route?.status).not.toBe('known');
      expect(tools).toContain('search_places');
      expect(tools).toContain('get_place_details');
      expect(tools.filter((tool) => tool === 'submit_cards')).toHaveLength(1);
      expect(upstream).toHaveBeenCalledTimes(tools.length);

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
      expect(isDevLiveModelEnvironment(env)).toBe(false);
      const response = await withDevFixtureCors(
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
