export type RuntimeGateSseEvent = Record<string, unknown>;

export type RuntimeGateSseOptions = {
  maxBytes?: number;
  maxMs?: number;
  namespace?: string;
  signal?: AbortSignal;
  onEvent?: (event: RuntimeGateSseEvent) => void;
};

export class RuntimeGateSseError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`M04_SSE_DENY_${code}`);
    this.name = 'RuntimeGateSseError';
    this.code = `M04_SSE_DENY_${code}`;
  }
}

type SseState = {
  namespace: string;
  toolIds: Map<string, string>;
  partIds: Map<string, string>;
};

const TOOL_ALLOWLIST = new Set(['search_places', 'get_place_details', 'submit_cards']);
const FINISH_REASONS = new Set([
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
]);
const SAFE_EVENT_TYPES = new Set([
  'start',
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
  'error',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-available',
  'tool-input-error',
  'tool-approval-request',
  'tool-output-available',
  'tool-output-error',
  'tool-output-denied',
  'start-step',
  'finish-step',
  'finish',
  'abort',
  'message-metadata',
]);

function isRecord(value: unknown): value is RuntimeGateSseEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(event: RuntimeGateSseEvent, key: string): string {
  const value = event[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeGateSseError('INVALID_UI_EVENT');
  }
  return value;
}

function safeToolId(raw: string, state: SseState): string {
  const existing = state.toolIds.get(raw);
  if (existing !== undefined) return existing;
  const next = `${state.namespace}-tool-${state.toolIds.size + 1}`;
  state.toolIds.set(raw, next);
  return next;
}

function safePartId(raw: string, prefix: string, state: SseState): string {
  const key = `${prefix}:${raw}`;
  const existing = state.partIds.get(key);
  if (existing !== undefined) return existing;
  const next = `${state.namespace}-${prefix}-${state.partIds.size + 1}`;
  state.partIds.set(key, next);
  return next;
}

function safeToolName(event: RuntimeGateSseEvent): string {
  const name = requiredString(event, 'toolName');
  if (!TOOL_ALLOWLIST.has(name)) throw new RuntimeGateSseError('UNKNOWN_TOOL');
  return name;
}

function safeFinishReason(event: RuntimeGateSseEvent): string | undefined {
  const value = event.finishReason;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !FINISH_REASONS.has(value)) {
    throw new RuntimeGateSseError('INVALID_FINISH_REASON');
  }
  return value;
}

function safeEvent(event: unknown, state: SseState): RuntimeGateSseEvent {
  if (!isRecord(event)) throw new RuntimeGateSseError('INVALID_UI_EVENT');
  const type = event.type;
  if (typeof type !== 'string' || !SAFE_EVENT_TYPES.has(type)) {
    throw new RuntimeGateSseError('UNSUPPORTED_UI_EVENT');
  }
  switch (type) {
    case 'start':
      return { type, messageId: `${state.namespace}-assistant` };
    case 'start-step':
    case 'finish-step':
      return { type };
    case 'text-start':
    case 'text-end':
      return { type, id: safePartId(requiredString(event, 'id'), 'text', state) };
    case 'text-delta':
      return {
        type,
        id: safePartId(requiredString(event, 'id'), 'text', state),
        delta: '',
      };
    case 'reasoning-start':
    case 'reasoning-end':
      return {
        type,
        id: safePartId(requiredString(event, 'id'), 'reasoning', state),
      };
    case 'reasoning-delta':
      return {
        type,
        id: safePartId(requiredString(event, 'id'), 'reasoning', state),
        delta: '',
      };
    case 'tool-input-start':
      return {
        type,
        toolCallId: safeToolId(requiredString(event, 'toolCallId'), state),
        toolName: safeToolName(event),
      };
    case 'tool-input-delta':
      return {
        type,
        toolCallId: safeToolId(requiredString(event, 'toolCallId'), state),
        inputTextDelta: '',
      };
    case 'tool-input-available':
      return {
        type,
        toolCallId: safeToolId(requiredString(event, 'toolCallId'), state),
        toolName: safeToolName(event),
        input: { status: 'withheld' },
      };
    case 'tool-input-error':
      return {
        type,
        toolCallId: safeToolId(requiredString(event, 'toolCallId'), state),
        toolName: safeToolName(event),
        input: { status: 'withheld' },
        errorText: 'TOOL_INPUT_WITHHELD',
      };
    case 'tool-approval-request':
      return {
        type,
        approvalId: `${state.namespace}-approval`,
        toolCallId: safeToolId(requiredString(event, 'toolCallId'), state),
      };
    case 'tool-output-available':
      return {
        type,
        toolCallId: safeToolId(requiredString(event, 'toolCallId'), state),
        output: { status: 'withheld' },
      };
    case 'tool-output-error':
      return {
        type,
        toolCallId: safeToolId(requiredString(event, 'toolCallId'), state),
        errorText: 'TOOL_OUTPUT_WITHHELD',
      };
    case 'tool-output-denied':
      return {
        type,
        toolCallId: safeToolId(requiredString(event, 'toolCallId'), state),
      };
    case 'finish': {
      const finishReason = safeFinishReason(event);
      return { type, ...(finishReason === undefined ? {} : { finishReason }) };
    }
    case 'abort':
      return { type, reason: 'CANCELLED' };
    case 'error':
      return { type, errorText: 'UPSTREAM_UNAVAILABLE' };
    case 'message-metadata':
      return { type, messageMetadata: { status: 'withheld' } };
    default:
      throw new RuntimeGateSseError('UNSUPPORTED_UI_EVENT');
  }
}

function parseBlock(block: string, state: SseState): RuntimeGateSseEvent | '[DONE]' | null {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) throw new RuntimeGateSseError('UNSUPPORTED_SSE_FIELD');
    data.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
  }
  if (data.length === 0) return null;
  const raw = data.join('\n');
  if (raw === '[DONE]') return '[DONE]';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new RuntimeGateSseError('INVALID_SSE_JSON');
  }
  return safeEvent(parsed, state);
}

export function sanitizeSseText(text: string, options: RuntimeGateSseOptions = {}): string {
  const maxBytes = options.maxBytes ?? 128 * 1024;
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RuntimeGateSseError('SSE_PAYLOAD_TOO_LARGE');
  }
  const state: SseState = {
    namespace: options.namespace ?? 'turn-safe',
    toolIds: new Map(),
    partIds: new Map(),
  };
  const output: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const safe = parseBlock(block, state);
    if (safe === null) continue;
    if (safe === '[DONE]') {
      output.push('data: [DONE]\n\n');
    } else {
      options.onEvent?.(safe);
      output.push(`data: ${JSON.stringify(safe)}\n\n`);
    }
  }
  if (output.length === 0) throw new RuntimeGateSseError('EMPTY_SSE_RESPONSE');
  return output.join('');
}

export async function sanitizeSseResponse(
  response: Response,
  options: RuntimeGateSseOptions = {},
): Promise<Response> {
  if (response.body === null) throw new RuntimeGateSseError('MISSING_SSE_BODY');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let stopCode: 'SSE_ABORTED' | 'SSE_TIMEOUT' | null = null;
  const maxBytes = options.maxBytes ?? 128 * 1024;
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  const onAbort = () => {
    stopCode = 'SSE_ABORTED';
    cancel();
  };
  const timer = setTimeout(() => {
    stopCode = 'SSE_TIMEOUT';
    cancel();
  }, options.maxMs ?? 2_000);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (options.signal?.aborted) throw new RuntimeGateSseError('SSE_ABORTED');
      const result = await reader.read();
      if (stopCode !== null) throw new RuntimeGateSseError(stopCode);
      if (result.done) break;
      if (result.value === undefined) throw new RuntimeGateSseError('SSE_READ_FAILED');
      const chunk =
        result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new RuntimeGateSseError('SSE_PAYLOAD_TOO_LARGE');
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (options.signal?.aborted) {
      const headers = new Headers(response.headers);
      headers.set('content-type', 'text/event-stream');
      return new Response('data: {"type":"abort","reason":"CANCELLED"}\n\ndata: [DONE]\n\n', {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    if (error instanceof RuntimeGateSseError) throw error;
    throw new RuntimeGateSseError(stopCode ?? 'SSE_READ_FAILED');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }

  const payload = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new RuntimeGateSseError('INVALID_UTF8');
  }
  const sanitized = sanitizeSseText(text, options);
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/event-stream');
  return new Response(sanitized, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
