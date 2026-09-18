import { generateText, Output } from 'ai';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveOpenAIProvider } from '@worker/infrastructure/adapters/outbound/providers/openai/model-provider';
import {
  ModelProviderConfigurationError,
  OPENAI_API_KEY_NAME,
  OPENAI_MODEL_NAME,
  OPENAI_REASONING_EFFORT,
} from '@worker/infrastructure/adapters/outbound/providers/openai/provider-config';

const API_KEY = 'sk-provider-test-only';

type CapturedRequest = {
  readonly url: string;
  readonly init: RequestInit | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const responseBody = (text: string): Record<string, unknown> => ({
  id: 'resp-provider-test',
  created_at: 1,
  model: OPENAI_MODEL_NAME,
  output: [
    {
      type: 'message',
      role: 'assistant',
      id: 'msg-provider-test',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 1,
    output_tokens: 2,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
});

const stubFetch = (body: unknown, status = 200): { readonly calls: CapturedRequest[] } => {
  const calls: CapturedRequest[] = [];
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: requestUrl(input), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  return { calls };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('live OpenAI Responses provider', () => {
  it('calls the fixed Responses model with auth only in the HTTP header', async () => {
    const { calls } = stubFetch(responseBody('{"answer":"mock provider response"}'));
    const provider = createLiveOpenAIProvider({ [OPENAI_API_KEY_NAME]: API_KEY });

    const result = await generateText({
      model: provider.model,
      prompt: 'provider boundary test',
      output: Output.object({ schema: z.object({ answer: z.string() }) }),
      providerOptions: provider.providerOptions,
    });

    expect(result.output).toEqual({ answer: 'mock provider response' });
    expect(provider.profile).toEqual({
      provider: 'openai',
      model: OPENAI_MODEL_NAME,
      reasoningEffort: OPENAI_REASONING_EFFORT,
    });
    expect(JSON.stringify(provider.profile)).not.toContain(API_KEY);
    expect(provider.providerOptions).toEqual({
      openai: { reasoningEffort: OPENAI_REASONING_EFFORT, strictJsonSchema: false, store: false },
    });

    expect(calls).toHaveLength(1);
    const request = calls[0];
    if (request === undefined) throw new Error('provider did not issue a request');
    expect(request.url).toBe('https://api.openai.com/v1/responses');
    const headers = new Headers(request.init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    const body = request.init?.body;
    expect(typeof body).toBe('string');
    if (typeof body !== 'string') return;
    const parsed: unknown = JSON.parse(body);
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) return;
    expect(parsed.model).toBe(OPENAI_MODEL_NAME);
    expect(parsed.reasoning).toEqual({ effort: OPENAI_REASONING_EFFORT });
    expect(parsed.store).toBe(false);
    const text = parsed.text;
    expect(isRecord(text)).toBe(true);
    if (!isRecord(text)) return;
    const format = text.format;
    expect(isRecord(format)).toBe(true);
    if (!isRecord(format)) return;
    expect(format.strict).toBe(false);
    expect(body).not.toContain(API_KEY);
  });

  it('rejects construction when the live API key is absent', () => {
    expect(() => createLiveOpenAIProvider({})).toThrowError(ModelProviderConfigurationError);
    expect(() => createLiveOpenAIProvider({ [OPENAI_API_KEY_NAME]: '   ' })).toThrowError(
      ModelProviderConfigurationError,
    );
  });

  it('propagates an SDK HTTP failure instead of returning a successful result', async () => {
    const { calls } = stubFetch(
      { error: { message: 'provider unavailable', type: 'server_error', code: 'upstream' } },
      500,
    );
    const provider = createLiveOpenAIProvider({ [OPENAI_API_KEY_NAME]: API_KEY });

    await expect(
      generateText({
        model: provider.model,
        prompt: 'provider error boundary test',
        maxRetries: 0,
        providerOptions: provider.providerOptions,
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
