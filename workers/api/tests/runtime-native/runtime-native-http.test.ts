import * as v from 'valibot';
import { SELF } from 'cloudflare:test';
import {
  CreateThreadResponseSchema,
  ErrorResponseSchema,
  SearchResponseSchema,
  ThreadReadResponseSchema,
  ThreadTurnRequestSchema,
  type ThreadTurnRequest,
} from '@ima/contracts';
import { describe, expect, it } from 'vitest';

const APP_TOKEN = 'test-app-token';
const OWNER_CREDENTIAL = 'A'.repeat(42) + 'E';
const SERVER_NOW = '2026-09-10T12:00:00Z';

const requestHeaders = (requestId: string, deviceId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-app-token': APP_TOKEN,
  'x-device-id': deviceId,
  'x-ima-owner-credential': OWNER_CREDENTIAL,
  'x-ima-request-id': requestId,
  'x-app-version': 'm10-runtime-native-test',
});

const call = async (
  path: string,
  requestId: string,
  deviceId: string,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = new Headers(requestHeaders(requestId, deviceId));
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return SELF.fetch(`https://ima.test${path}`, { ...init, headers });
};

const createThread = async (): Promise<{ readonly threadId: string }> => {
  const requestId = `native-http-create-${crypto.randomUUID()}`;
  const response = await call(
    '/v1/threads',
    requestId,
    `native-http-device-${crypto.randomUUID()}`,
    {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId,
        idempotencyKey: `native-http-create-key-${crypto.randomUUID()}`,
      }),
    },
  );
  expect(response.status).toBe(201);
  const parsed = v.safeParse(CreateThreadResponseSchema, await response.json());
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('thread creation response is invalid');
  return { threadId: parsed.output.threadId };
};

const turnBody = (
  requestId: string,
  scenario: 'invalid-submit-details-valid' | 'unexpected-sdk-error',
): ThreadTurnRequest => {
  const parsed = v.safeParse(ThreadTurnRequestSchema, {
    schemaVersion: 'v1',
    requestId,
    turnId: `turn-${crypto.randomUUID()}`,
    revision: 1,
    text: `[runtime-native:${scenario}] fixture turn`,
    clientNow: SERVER_NOW,
    location: {
      status: 'unavailable',
      lat: null,
      lng: null,
      accuracyMeters: null,
      precise: false,
      capturedAt: null,
    },
    prefs: {
      homeStationRef: null,
      maxWalkMinutes: null,
      minimumStayMinutes: null,
      areaText: 'runtime native fixture',
      budget: 'normal',
    },
    savedPlaceRefs: [],
    excludeCandidateIds: [],
    mode: 'search',
    idempotencyKey: `native-http-turn-key-${crypto.randomUUID()}`,
  });
  if (!parsed.success) throw new Error('runtime native turn fixture is invalid');
  return parsed.output;
};

describe('runtime native HTTP composition', () => {
  it('returns the initial response and exposes GET replay as a reference', async () => {
    const { threadId } = await createThread();
    const requestId = `native-http-turn-${crypto.randomUUID()}`;
    const deviceId = `native-http-device-${crypto.randomUUID()}`;
    const input = turnBody(requestId, 'invalid-submit-details-valid');
    const body = JSON.stringify(input);

    const first = await call(`/v1/threads/${threadId}/turns`, requestId, deviceId, {
      method: 'POST',
      body,
    });
    expect(first.status).toBe(200);
    const firstParsed = v.safeParse(SearchResponseSchema, await first.json());
    expect(firstParsed.success).toBe(true);
    if (!firstParsed.success) return;
    expect(firstParsed.output.requestId).toBe(requestId);
    expect(firstParsed.output.response.kind).toBe('cards');
    expect(firstParsed.output.response.threadId).toBe(threadId);
    expect(firstParsed.output.response.turnId).toBe(input.turnId);
    expect(firstParsed.output.response.revision).toBe(2);
    expect(JSON.stringify(firstParsed.output)).not.toContain('runtime-native-candidate');

    const replayRequestId = `native-http-replay-${crypto.randomUUID()}`;
    const replay = await call(
      `/v1/threads/${threadId}/replay`,
      replayRequestId,
      `native-http-device-${crypto.randomUUID()}`,
    );
    expect(replay.status).toBe(200);
    const replayParsed = v.safeParse(ThreadReadResponseSchema, await replay.json());
    expect(replayParsed.success).toBe(true);
    if (!replayParsed.success) return;
    expect(replayParsed.output.threadId).toBe(threadId);
    expect(replayParsed.output.revision).toBe(2);
    expect(replayParsed.output.responses).toHaveLength(1);
    const record = replayParsed.output.responses[0];
    expect(record?.restoreMode).toBe('reference_only');
    expect(record !== undefined && 'message' in record).toBe(false);
    expect(record !== undefined && 'cards' in record).toBe(false);
    expect(JSON.stringify(replayParsed.output)).not.toContain('runtime-native-candidate');
  });

  it('rejects the same-body duplicate POST as a conflict', async () => {
    const { threadId } = await createThread();
    const requestId = `native-http-duplicate-${crypto.randomUUID()}`;
    const deviceId = `native-http-device-${crypto.randomUUID()}`;
    const body = JSON.stringify(turnBody(requestId, 'invalid-submit-details-valid'));

    const first = await call(`/v1/threads/${threadId}/turns`, requestId, deviceId, {
      method: 'POST',
      body,
    });
    expect(first.status).toBe(200);
    await first.arrayBuffer();

    const duplicate = await call(`/v1/threads/${threadId}/turns`, requestId, deviceId, {
      method: 'POST',
      body,
    });
    expect(duplicate.status).toBe(409);
    const duplicateParsed = v.safeParse(ErrorResponseSchema, await duplicate.json());
    expect(duplicateParsed.success).toBe(true);
    if (!duplicateParsed.success) return;
    expect(duplicateParsed.output.requestId).toBe(requestId);
    expect(duplicateParsed.output.code).toBe('CONFLICT');
    expect(JSON.stringify(duplicateParsed.output)).not.toContain('runtime-native-candidate');
  });

  it('rejects a different turn submitted at the old revision as stale', async () => {
    const { threadId } = await createThread();
    const firstRequestId = `native-http-stale-first-${crypto.randomUUID()}`;
    const first = await call(
      `/v1/threads/${threadId}/turns`,
      firstRequestId,
      `native-http-device-${crypto.randomUUID()}`,
      {
        method: 'POST',
        body: JSON.stringify(turnBody(firstRequestId, 'invalid-submit-details-valid')),
      },
    );
    expect(first.status).toBe(200);
    await first.arrayBuffer();

    const staleRequestId = `native-http-stale-${crypto.randomUUID()}`;
    const stale = await call(
      `/v1/threads/${threadId}/turns`,
      staleRequestId,
      `native-http-device-${crypto.randomUUID()}`,
      {
        method: 'POST',
        body: JSON.stringify(turnBody(staleRequestId, 'invalid-submit-details-valid')),
      },
    );
    expect(stale.status).toBe(409);
    const staleParsed = v.safeParse(ErrorResponseSchema, await stale.json());
    expect(staleParsed.success).toBe(true);
    if (!staleParsed.success) return;
    expect(staleParsed.output.requestId).toBe(staleRequestId);
    expect(staleParsed.output.code).toBe('STALE_TURN');
  });

  it('keeps a scripted SDK failure inside the public error vocabulary', async () => {
    const { threadId } = await createThread();
    const requestId = `native-http-error-${crypto.randomUUID()}`;
    const errorResponse = await call(
      `/v1/threads/${threadId}/turns`,
      requestId,
      `native-http-device-${crypto.randomUUID()}`,
      {
        method: 'POST',
        body: JSON.stringify(turnBody(requestId, 'unexpected-sdk-error')),
      },
    );
    expect(errorResponse.status).toBe(500);
    const parsed = v.safeParse(ErrorResponseSchema, await errorResponse.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.output.status).toBe(500);
    expect(parsed.output.code).toBe('INTERNAL');
    expect(JSON.stringify(parsed.output)).not.toContain('UPSTREAM_UNAVAILABLE');
    expect(JSON.stringify(parsed.output)).not.toContain('runtime native scripted provider failed');

    const replay = await call(
      `/v1/threads/${threadId}/replay`,
      `native-http-error-replay-${crypto.randomUUID()}`,
      `native-http-device-${crypto.randomUUID()}`,
    );
    expect(replay.status).toBe(200);
    const replayParsed = v.safeParse(ThreadReadResponseSchema, await replay.json());
    expect(replayParsed.success).toBe(true);
    if (!replayParsed.success) return;
    expect(replayParsed.output.revision).toBe(1);
    expect(replayParsed.output.responses).toHaveLength(0);
  });
});
