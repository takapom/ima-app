import * as v from 'valibot';
import { RequestIdSchema } from '@ima/contracts';
import type { BoundaryFailure } from './errors';

export type JsonBodyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: BoundaryFailure };

export type JsonBodyWithRawResult<T> =
  | { readonly ok: true; readonly value: T; readonly rawBody: Uint8Array }
  | { readonly ok: false; readonly failure: BoundaryFailure };

const invalidArgument = (): BoundaryFailure => ({ status: 400, code: 'INVALID_ARGUMENT' });
const payloadTooLarge = (): BoundaryFailure => ({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
const unsupportedMediaType = (): BoundaryFailure => ({
  status: 415,
  code: 'UNSUPPORTED_MEDIA_TYPE',
});

const requestMediaType = (request: Request): string | null => {
  const value = request.headers.get('content-type');
  if (value === null) return null;
  const separator = value.indexOf(';');
  return value
    .slice(0, separator === -1 ? value.length : separator)
    .trim()
    .toLowerCase();
};

const contentLength = (request: Request): number | null | 'invalid' => {
  const value = request.headers.get('content-length');
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : 'invalid';
};

const readBody = async (
  request: Request,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly text: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly failure: BoundaryFailure }
> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return { ok: false, failure: { status: 500, code: 'INTERNAL' } };
  }

  const declared = contentLength(request);
  if (declared === 'invalid') return { ok: false, failure: invalidArgument() };
  if (declared !== null && declared > maxBytes) {
    return { ok: false, failure: payloadTooLarge() };
  }

  const stream = request.body;
  if (stream === null) return { ok: true, text: '', bytes: new Uint8Array() };

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is already known; a cancellation failure must not change 413.
        }
        return { ok: false, failure: payloadTooLarge() };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, failure: invalidArgument() };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      bytes,
    };
  } catch {
    return { ok: false, failure: invalidArgument() };
  }
};

/** Parse and validate a bounded JSON request while retaining the exact body bytes. */
export const parseJsonBodyWithRaw = async <Schema extends v.GenericSchema>(
  request: Request,
  schema: Schema,
  maxBytes: number,
): Promise<JsonBodyWithRawResult<v.InferOutput<Schema>>> => {
  if (requestMediaType(request) !== 'application/json') {
    return { ok: false, failure: unsupportedMediaType() };
  }

  const body = await readBody(request, maxBytes);
  if (!body.ok) return body;

  let value: unknown;
  try {
    value = JSON.parse(body.text) as unknown;
  } catch {
    return { ok: false, failure: invalidArgument() };
  }

  const parsed = v.safeParse(schema, value);
  return parsed.success
    ? { ok: true, value: parsed.output, rawBody: body.bytes }
    : { ok: false, failure: invalidArgument() };
};

/** Parse and validate a bounded JSON request before any application side effect. */
export const parseJsonBody = async <Schema extends v.GenericSchema>(
  request: Request,
  schema: Schema,
  maxBytes: number,
): Promise<JsonBodyResult<v.InferOutput<Schema>>> => {
  const result = await parseJsonBodyWithRaw(request, schema, maxBytes);
  return result.ok ? { ok: true, value: result.value } : result;
};

export const isValidRequestId = (requestId: string | null): requestId is string =>
  requestId !== null && v.safeParse(RequestIdSchema, requestId).success;
