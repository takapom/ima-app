import {
  parseConversationRunResponse,
  parseConversationId,
  type ConversationRunResponse,
} from '@ima/contracts';
import type { ApiClientOptions } from '@mobile/platform/http/api';
import { buildApiUrl, credentialHeaders } from '@mobile/platform/http/request-helpers';

export const watchConversationRun = async (
  options: ApiClientOptions,
  conversationId: string,
  runId: string,
  receive: (value: ConversationRunResponse) => void,
  signal: AbortSignal,
): Promise<void> => {
  const requestId = options.requestIdFactory();
  if (![conversationId, runId, requestId].every((id) => parseConversationId(id).success))
    throw new Error('CONVERSATION_ID_INVALID');
  const headers = await credentialHeaders(options, requestId);
  const url = buildApiUrl(
    options.baseUrl,
    `/v1/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/events`,
    options.mode,
  );
  if (!headers.ok || url === null) throw new Error('CONVERSATION_STREAM_CONFIGURATION');
  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (signal.aborted) cancel();
  signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 100_000);
  try {
    const fetcher = options.fetchImpl ?? (await import('expo/fetch')).fetch;
    const response = await fetcher(url.toString(), {
      headers: { ...headers.headers, accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (
      response.status !== 200 ||
      !response.headers.get('content-type')?.includes('text/event-stream') ||
      response.body === null
    )
      throw new Error('CONVERSATION_STREAM_UNAVAILABLE');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!abort.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replaceAll('\r\n', '\n');
        if (buffer.length > 1_048_576) throw new Error('CONVERSATION_STREAM_TOO_LARGE');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = frame.split('\n');
          const event = lines
            .find((line) => line.startsWith('event:'))
            ?.slice(6)
            .trim();
          if (event === 'unavailable') throw new Error('CONVERSATION_STREAM_UNAVAILABLE');
          if (event !== 'run') continue;
          const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          const parsed = parseConversationRunResponse(JSON.parse(data));
          if (!parsed.success) throw new Error('CONVERSATION_STREAM_INVALID');
          const value = parsed.data;
          if (
            value.requestId !== requestId ||
            value.conversation.conversationId !== conversationId ||
            value.run.conversationId !== conversationId ||
            value.run.runId !== runId
          )
            throw new Error('CONVERSATION_STREAM_SCOPE_MISMATCH');
          if (signal.aborted) return;
          receive(value);
          if (value.run.status !== 'accepted' && value.run.status !== 'running') return;
        }
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
};
