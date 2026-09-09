import { expect, it } from 'vitest';
import {
  RuntimeGateSseError,
  sanitizeSseResponse,
  sanitizeSseText,
  type RuntimeGateSseEvent,
} from './runtime-gate-sse';

function canary(label: string): string {
  return `M04_SSE_${label}_${crypto.randomUUID()}`;
}

function sseText(events: readonly (RuntimeGateSseEvent | '[DONE]')[]): string {
  return events
    .map((event) =>
      event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
}

function parseSseText(text: string): Array<RuntimeGateSseEvent | '[DONE]'> {
  return text
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const data = block
        .split(/\r?\n/)
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trimStart();
      if (data === '[DONE]') return '[DONE]';
      if (data === undefined) throw new Error('test SSE data line missing');
      return JSON.parse(data) as RuntimeGateSseEvent;
    });
}

function responseFromChunks(text: string, chunkSize: number): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
          controller.enqueue(bytes.slice(offset, offset + chunkSize));
        }
        controller.close();
      },
    }),
    { status: 202, headers: { 'x-fixture': 'sse' } },
  );
}

function pendingResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
    }),
  );
}

it('rebuilds every persisted UI event and withholds arbitrary canaries', () => {
  const marker = canary('STRUCTURE');
  const observed: RuntimeGateSseEvent[] = [];
  const sanitized = sanitizeSseText(
    sseText([
      { type: 'start', messageId: marker, raw: marker },
      { type: 'text-start', id: marker, providerMetadata: marker },
      { type: 'text-delta', id: marker, delta: `answer ${marker}` },
      { type: 'text-end', id: marker },
      { type: 'reasoning-start', id: marker },
      { type: 'reasoning-delta', id: marker, delta: marker },
      { type: 'reasoning-end', id: marker },
      { type: 'tool-input-start', toolCallId: marker, toolName: 'search_places' },
      { type: 'tool-input-delta', toolCallId: marker, inputTextDelta: marker },
      {
        type: 'tool-input-available',
        toolCallId: marker,
        toolName: 'search_places',
        input: { secret: marker },
      },
      {
        type: 'tool-input-error',
        toolCallId: marker,
        toolName: 'search_places',
        errorText: marker,
      },
      { type: 'tool-approval-request', approvalId: marker, toolCallId: marker },
      { type: 'tool-output-available', toolCallId: marker, output: { secret: marker } },
      { type: 'tool-output-error', toolCallId: marker, errorText: marker },
      { type: 'tool-output-denied', toolCallId: marker, reason: marker },
      { type: 'start-step', raw: marker },
      { type: 'finish-step', raw: marker },
      { type: 'message-metadata', messageMetadata: { secret: marker } },
      { type: 'error', errorText: marker },
      { type: 'abort', reason: marker },
      { type: 'finish', finishReason: 'stop', rawFinishReason: marker },
      '[DONE]',
    ]),
    { namespace: 'sse-test', onEvent: (event) => observed.push(event) },
  );
  const output = parseSseText(sanitized);

  expect(sanitized).not.toContain(marker);
  expect(JSON.stringify(observed)).not.toContain(marker);
  expect(output.at(-1)).toBe('[DONE]');
  expect(output[0]).toEqual({ type: 'start', messageId: 'sse-test-assistant' });
  expect(output.find((event) => event !== '[DONE]' && event.type === 'text-delta')).toEqual({
    type: 'text-delta',
    id: 'sse-test-text-1',
    delta: '',
  });
  expect(
    output.find((event) => event !== '[DONE]' && event.type === 'tool-input-available'),
  ).toEqual({
    type: 'tool-input-available',
    toolCallId: 'sse-test-tool-1',
    toolName: 'search_places',
    input: { status: 'withheld' },
  });
  expect(output.find((event) => event !== '[DONE]' && event.type === 'error')).toEqual({
    type: 'error',
    errorText: 'UPSTREAM_UNAVAILABLE',
  });
  expect(output.find((event) => event !== '[DONE]' && event.type === 'abort')).toEqual({
    type: 'abort',
    reason: 'CANCELLED',
  });
});

it('rejects unknown provider parts before invoking the persistence observer', () => {
  const marker = canary('UNKNOWN');
  const observed: RuntimeGateSseEvent[] = [];

  expect(() =>
    sanitizeSseText(sseText([{ type: 'provider-data', payload: marker }]), {
      onEvent: (event) => observed.push(event),
    }),
  ).toThrowError(new RuntimeGateSseError('UNSUPPORTED_UI_EVENT'));
  expect(observed).toEqual([]);
});

it('reassembles arbitrarily split SSE chunks before sanitizing and preserves safe headers', async () => {
  const marker = canary('CHUNKS');
  const source = sseText([
    { type: 'start', messageId: marker },
    { type: 'text-start', id: marker },
    { type: 'text-delta', id: marker, delta: marker },
    { type: 'text-end', id: marker },
    { type: 'finish', finishReason: 'stop' },
    '[DONE]',
  ]);
  const response = await sanitizeSseResponse(responseFromChunks(source, 3), {
    namespace: 'chunk-test',
  });
  const output = await response.text();

  expect(response.status).toBe(202);
  expect(response.headers.get('x-fixture')).toBe('sse');
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(output).not.toContain(marker);
  expect(parseSseText(output)).toEqual([
    { type: 'start', messageId: 'chunk-test-assistant' },
    { type: 'text-start', id: 'chunk-test-text-1' },
    { type: 'text-delta', id: 'chunk-test-text-1', delta: '' },
    { type: 'text-end', id: 'chunk-test-text-1' },
    { type: 'finish', finishReason: 'stop' },
    '[DONE]',
  ]);
});

it('returns a synthetic abort and hides upstream stream errors', async () => {
  const controller = new AbortController();
  const abortResponse = sanitizeSseResponse(pendingResponse(), {
    signal: controller.signal,
    maxMs: 1_000,
  });
  controller.abort();
  const aborted = await abortResponse;
  expect(await aborted.text()).toBe(
    'data: {"type":"abort","reason":"CANCELLED"}\n\ndata: [DONE]\n\n',
  );

  const marker = canary('READ_ERROR');
  const failedResponse = new Response(
    new ReadableStream<Uint8Array>({
      start(stream) {
        stream.error(new Error(marker));
      },
    }),
  );
  await expect(sanitizeSseResponse(failedResponse)).rejects.toMatchObject({
    code: 'M04_SSE_DENY_SSE_READ_FAILED',
    message: 'M04_SSE_DENY_SSE_READ_FAILED',
  });
});
