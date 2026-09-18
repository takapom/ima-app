import * as v from 'valibot';
import { expect, it } from 'vitest';
import {
  APP_TOKEN_HEADER,
  APP_VERSION_HEADER,
  DEVICE_ID_HEADER,
  OWNER_CREDENTIAL_HEADER,
  OwnerCredentialHeaderSchema,
  PublicErrorSchema,
  REQUEST_ID_HEADER,
  RequestHeadersSchema,
} from '@ima/contracts';
import type { AuthenticationResult } from '@worker/infrastructure/adapters/inbound/http/auth';
import {
  authenticateRequest,
  deriveOwnerScopeRef,
} from '@worker/infrastructure/adapters/inbound/http/auth';
import {
  toErrorResponse,
  toPublicError,
} from '@worker/infrastructure/adapters/inbound/http/errors';
import { parseJsonBody } from '@worker/infrastructure/adapters/inbound/http/input';

const OWNER_CREDENTIAL = `${'A'.repeat(42)}A`;
const OTHER_OWNER_CREDENTIAL = `${'A'.repeat(41)}B${'A'}`;

const requestWithHeaders = (headers: Record<string, string> = {}, body?: string): Request => {
  const init: RequestInit = {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      [APP_TOKEN_HEADER]: 'dev-token',
      [DEVICE_ID_HEADER]: 'device-1',
      [OWNER_CREDENTIAL_HEADER]: OWNER_CREDENTIAL,
      [REQUEST_ID_HEADER]: 'request-1',
      [APP_VERSION_HEADER]: '1.0.0',
      ...headers,
    },
  };
  if (body !== undefined) init.body = body;
  return new Request('https://ima.test/v1/threads', init);
};

const failureOf = (result: AuthenticationResult) => {
  if (result.ok) throw new Error('expected authentication to fail');
  return result.failure;
};

it('derives a stable owner scope from a valid credential without exposing it', async () => {
  const first = await deriveOwnerScopeRef(OWNER_CREDENTIAL);
  const repeat = await deriveOwnerScopeRef(OWNER_CREDENTIAL);
  const other = await deriveOwnerScopeRef(OTHER_OWNER_CREDENTIAL);

  expect(first).not.toBeNull();
  expect(repeat).toBe(first);
  expect(other).not.toBe(first);
  expect(first).not.toContain(OWNER_CREDENTIAL);
  expect(await deriveOwnerScopeRef('invalid')).toBeNull();
  expect(v.safeParse(OwnerCredentialHeaderSchema, OWNER_CREDENTIAL).success).toBe(true);
});

it('keeps app token authentication separate from owner scope authentication', async () => {
  const authenticated = await authenticateRequest(requestWithHeaders(), {
    appToken: 'dev-token',
    requestIdFactory: () => 'generated-request',
  });

  expect(authenticated.ok).toBe(true);
  if (!authenticated.ok) throw new Error('expected valid authentication');
  expect(authenticated.context.ownerScopeRef).not.toBe('dev-token');
  expect(authenticated.context.ownerScopeRef).not.toContain(OWNER_CREDENTIAL);
  expect(authenticated.context.deviceId).toBe('device-1');

  const otherOwner = await authenticateRequest(
    requestWithHeaders({ [OWNER_CREDENTIAL_HEADER]: OTHER_OWNER_CREDENTIAL }),
    { appToken: 'dev-token', requestIdFactory: () => 'generated-request' },
  );
  expect(otherOwner.ok).toBe(true);
  if (!otherOwner.ok) throw new Error('expected other owner authentication');
  expect(otherOwner.context.ownerScopeRef).not.toBe(authenticated.context.ownerScopeRef);

  const badAppToken = await authenticateRequest(
    requestWithHeaders({ [APP_TOKEN_HEADER]: 'owner-like-device-value' }),
    { appToken: 'dev-token', requestIdFactory: () => 'generated-request' },
  );
  expect(failureOf(badAppToken)).toEqual({ status: 401, code: 'UNAUTHORIZED' });

  const badOwner = await authenticateRequest(
    requestWithHeaders({ [OWNER_CREDENTIAL_HEADER]: 'bad-owner' }),
    { appToken: 'dev-token', requestIdFactory: () => 'generated-request' },
  );
  expect(failureOf(badOwner)).toEqual({ status: 401, code: 'UNAUTHORIZED' });

  const emptyConfig = await authenticateRequest(requestWithHeaders({ [APP_TOKEN_HEADER]: '' }), {
    appToken: '',
    requestIdFactory: () => 'generated-request',
  });
  expect(failureOf(emptyConfig)).toEqual({ status: 500, code: 'INTERNAL' });
});

it('rejects malformed request headers without using a supplied invalid request id', async () => {
  const malformed = await authenticateRequest(
    requestWithHeaders({ [REQUEST_ID_HEADER]: 'bad request id' }),
    { appToken: 'dev-token', requestIdFactory: () => 'generated-request' },
  );

  expect(failureOf(malformed)).toEqual({ status: 400, code: 'INVALID_ARGUMENT' });
  if (malformed.ok) throw new Error('expected malformed headers to fail');
  expect(malformed.requestId).toBe('generated-request');
  expect(
    v.safeParse(RequestHeadersSchema, {
      appToken: 'dev-token',
      deviceId: 'device-1',
      ownerCredential: OWNER_CREDENTIAL,
      requestId: 'request-1',
      appVersion: '1.0.0',
    }).success,
  ).toBe(true);
});

const InputSchema = v.strictObject({ value: v.pipe(v.string(), v.minLength(1)) });

it('validates content type, byte limits, JSON, and strict DTO shape before returning input', async () => {
  const valid = await parseJsonBody(
    new Request('https://ima.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ value: 'ok' }),
    }),
    InputSchema,
    128,
  );
  expect(valid).toEqual({ ok: true, value: { value: 'ok' } });

  const mediaType = await parseJsonBody(
    new Request('https://ima.test', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ value: 'ok' }),
    }),
    InputSchema,
    128,
  );
  expect(mediaType).toEqual({
    ok: false,
    failure: { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  });

  const oversized = await parseJsonBody(
    new Request('https://ima.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'too large' }),
    }),
    InputSchema,
    4,
  );
  expect(oversized).toEqual({
    ok: false,
    failure: { status: 413, code: 'PAYLOAD_TOO_LARGE' },
  });

  const cancellationFailureBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"value":"too large"}'));
    },
    cancel() {
      return Promise.reject(new Error('body cancellation failed'));
    },
  });
  const cancellationFailureInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: cancellationFailureBody,
    duplex: 'half',
  } satisfies RequestInit & { duplex: 'half' };
  const cancellationFailure = await parseJsonBody(
    new Request('https://ima.test', cancellationFailureInit),
    InputSchema,
    4,
  );
  expect(cancellationFailure).toEqual({
    ok: false,
    failure: { status: 413, code: 'PAYLOAD_TOO_LARGE' },
  });

  const multibyteBody = JSON.stringify({ value: 'あ' });
  const multibyteBytes = new TextEncoder().encode(multibyteBody).byteLength;
  const exactLimit = await parseJsonBody(
    new Request('https://ima.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: multibyteBody,
    }),
    InputSchema,
    multibyteBytes,
  );
  expect(exactLimit).toEqual({ ok: true, value: { value: 'あ' } });

  const oneByteUnderLimit = await parseJsonBody(
    new Request('https://ima.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: multibyteBody,
    }),
    InputSchema,
    multibyteBytes - 1,
  );
  expect(oneByteUnderLimit).toEqual({
    ok: false,
    failure: { status: 413, code: 'PAYLOAD_TOO_LARGE' },
  });

  const malformedJson = await parseJsonBody(
    new Request('https://ima.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }),
    InputSchema,
    128,
  );
  expect(malformedJson).toEqual({
    ok: false,
    failure: { status: 400, code: 'INVALID_ARGUMENT' },
  });

  const unknownProperty = await parseJsonBody(
    new Request('https://ima.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'ok', extra: true }),
    }),
    InputSchema,
    128,
  );
  expect(unknownProperty).toEqual({
    ok: false,
    failure: { status: 400, code: 'INVALID_ARGUMENT' },
  });
});

it('maps only public error codes and never serializes internal details', async () => {
  const error = toPublicError('invalid request id', {
    status: 500,
    code: 'INTERNAL',
  });
  expect(error).toEqual({
    schemaVersion: 'v1',
    requestId: 'request-generated',
    status: 500,
    code: 'INTERNAL',
    message: 'The server could not complete the request.',
  });
  expect(JSON.stringify(error)).not.toContain('stack');

  const response = toErrorResponse('request-1', { status: 413, code: 'PAYLOAD_TOO_LARGE' });
  expect(response.status).toBe(413);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const parsed = v.safeParse(PublicErrorSchema, await response.json());
  expect(parsed.success).toBe(true);
});
