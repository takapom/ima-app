import { describe, expect, it } from 'vitest';
import {
  parseConversationTurnRequest,
  parsePrefsWriteRequest,
  parseSearchRequest,
  parseThreadTurnRequest,
  type ConversationTurnRequest,
  type PrefsWriteRequest,
  type SearchRequest,
  type ThreadTurnRequest,
} from '@ima/contracts';
import { createJourneyApiClient } from '@mobile/platform/http/client';
import { createConversationClient } from '@mobile/platform/http/conversation-client';
import { createOwnerPrefsClient } from '@mobile/platform/http/owner-client';
import type { ApiClientOptions } from '@mobile/platform/http/api';

const prefs = { areaText: '恵比寿', budget: 'normal' as const };
const turnInput: ThreadTurnRequest = {
  schemaVersion: 'v1',
  requestId: 'request-compatible',
  turnId: 'turn-1',
  revision: 1,
  text: '静かな店',
  clientNow: '2026-09-10T12:00:00Z',
  location: {
    status: 'unavailable',
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs,
  excludeCandidateIds: ['candidate-excluded'],
  mode: 'search',
  idempotencyKey: 'idempotency-compatible',
};
const searchInput: SearchRequest = { ...turnInput, threadId: 'thread-1' };
const conversationInput: ConversationTurnRequest = {
  schemaVersion: turnInput.schemaVersion,
  requestId: turnInput.requestId,
  text: turnInput.text,
  clientNow: turnInput.clientNow,
  location: turnInput.location,
  prefs,
  excludeCandidateIds: turnInput.excludeCandidateIds,
  mode: turnInput.mode,
  idempotencyKey: turnInput.idempotencyKey,
  expectedRevision: 1,
  clientMessageId: 'message-1',
};
const prefsInput: PrefsWriteRequest = {
  schemaVersion: 'v1',
  requestId: turnInput.requestId,
  expectedRevision: 0,
  prefs,
};

// Required wire keys in the pre-#54/#55 Worker (56520e5), including neutral values.
const oldPrefs = { ...prefs, homeStationRef: null, maxWalkMinutes: null, minimumStayMinutes: null };
const cases = [
  {
    path: '/v1/search',
    method: 'POST',
    input: searchInput,
    expectedBody: { ...searchInput, prefs: oldPrefs, savedPlaceRefs: [] },
    parse: parseSearchRequest,
    send: (options: ApiClientOptions) => createJourneyApiClient(options).search(searchInput),
  },
  {
    path: '/v1/threads/thread-1/turns',
    method: 'POST',
    input: turnInput,
    expectedBody: { ...turnInput, prefs: oldPrefs, savedPlaceRefs: [] },
    parse: parseThreadTurnRequest,
    send: (options: ApiClientOptions) =>
      createJourneyApiClient(options).turn('thread-1', turnInput),
  },
  {
    path: '/v1/conversations/conversation-1/turns',
    method: 'POST',
    input: conversationInput,
    expectedBody: { ...conversationInput, prefs: oldPrefs, savedPlaceRefs: [] },
    parse: parseConversationTurnRequest,
    send: (options: ApiClientOptions) =>
      createConversationClient(options).send('conversation-1', conversationInput),
  },
  {
    path: '/v1/prefs',
    method: 'PUT',
    input: prefsInput,
    expectedBody: { ...prefsInput, prefs: oldPrefs },
    parse: parsePrefsWriteRequest,
    send: (options: ApiClientOptions) => createOwnerPrefsClient(options).putPrefs(prefsInput),
  },
];

const captureRequests = () => {
  const calls: { path: string; method: string | undefined; body: unknown }[] = [];
  const options: ApiClientOptions = {
    baseUrl: 'http://localhost:8787',
    mode: 'fixture',
    appVersion: 'test',
    credentials: {
      appToken: 'app-token',
      deviceId: 'device-1',
      ownerCredential: 'A'.repeat(43),
    },
    requestIdFactory: () => turnInput.requestId,
    fetchImpl: (input, init) => {
      const request = new Request(input, init);
      calls.push({
        path: new URL(request.url).pathname,
        method: init?.method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      // The transport assertion concerns the sent JSON; no Worker runtime is executed here.
      return Promise.resolve(
        Response.json(
          {
            schemaVersion: 'v1',
            requestId: turnInput.requestId,
            status: 401,
            code: 'UNAUTHORIZED',
            message: 'Fixture response',
          },
          { status: 401 },
        ),
      );
    },
  };
  return { calls, options };
};

describe('app-first request compatibility', () => {
  it.each(cases)('sends old required keys for $method $path after validation', async (testCase) => {
    const { calls, options } = captureRequests();
    const before = structuredClone(testCase.input);
    await expect(testCase.send(options)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'http', status: 401 },
    });
    expect(calls).toEqual([
      { path: testCase.path, method: testCase.method, body: testCase.expectedBody },
    ]);
    const current = testCase.parse(calls[0]?.body);
    expect(current.success).toBe(true);
    if (!current.success) throw new Error('Current Worker rejected the request');
    expect(current.data.prefs).toEqual(prefs);
    expect(testCase.input).toEqual(before);
  });

  it('never reactivates retired conditions or consultation from a restored old input', async () => {
    const { calls, options } = captureRequests();
    await createJourneyApiClient(options).turn('thread-1', {
      ...turnInput,
      prefs: {
        ...prefs,
        ...{ homeStationRef: 'station-old', maxWalkMinutes: 15, minimumStayMinutes: 30 },
      },
      savedPlaceRefs: ['saved-old'],
    });
    expect(calls[0]?.body).toEqual({ ...turnInput, prefs: oldPrefs, savedPlaceRefs: [] });
  });
});
