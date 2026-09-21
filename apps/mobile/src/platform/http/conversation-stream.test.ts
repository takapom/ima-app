import { describe, expect, it, vi } from 'vitest';
import { watchConversationRun } from '@mobile/platform/http/conversation-stream';
import type { ApiClientOptions } from '@mobile/platform/http/api';

const now = '2026-09-21T10:00:00Z';
const value = {
  schemaVersion: 'v1',
  requestId: 'request',
  response: null,
  conversation: {
    conversationId: 'conversation',
    title: '日本語の会話',
    revision: 3,
    lastSequence: 2,
    createdAt: now,
    updatedAt: now,
  },
  run: {
    conversationId: 'conversation',
    runId: 'run',
    userMessageId: 'user',
    inputSequence: 1,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    threadId: 'thread',
    turnId: 'turn',
    assistantMessageId: 'answer',
    failure: null,
  },
};
const options = (payload: unknown, event = 'run'): ApiClientOptions => ({
  baseUrl: 'http://127.0.0.1:8787',
  mode: 'fixture',
  appVersion: 'test',
  requestIdFactory: () => 'request',
  credentials: {
    appToken: 'test-token',
    deviceId: 'device',
    ownerCredential: `${'A'.repeat(42)}A`,
  },
  fetchImpl: () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            // Split even within multi-byte characters and CRLF boundaries.
            for (const byte of new TextEncoder().encode(
              `event: ${event}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`,
            ))
              controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    ),
});
describe('conversation event stream', () => {
  it('decodes split UTF-8 and CRLF frames without losing Japanese text', async () => {
    const receive = vi.fn();
    await watchConversationRun(
      options(value),
      'conversation',
      'run',
      receive,
      new AbortController().signal,
    );
    expect(receive).toHaveBeenCalledExactlyOnceWith(value);
  });
  it('rejects another conversation and unavailable events without delivering content', async () => {
    const receive = vi.fn();
    await expect(
      watchConversationRun(
        options({ ...value, requestId: 'other' }),
        'conversation',
        'run',
        receive,
        new AbortController().signal,
      ),
    ).rejects.toThrow('SCOPE_MISMATCH');
    await expect(
      watchConversationRun(
        options({}, 'unavailable'),
        'conversation',
        'run',
        receive,
        new AbortController().signal,
      ),
    ).rejects.toThrow('UNAVAILABLE');
    expect(receive).not.toHaveBeenCalled();
  });
});
