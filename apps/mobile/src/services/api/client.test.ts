import { describe, expect, it, vi } from 'vitest';
import type {
  CreateThreadRequest,
  LifecycleCommand,
  SearchRequest,
  ThreadTurnRequest,
} from '@ima/contracts';
import { APP_TOKEN_HEADER, REQUEST_ID_HEADER } from '@ima/contracts';
import { createJourneyApiClient } from './client';
import type { ApiClientOptions, ApiFetch } from './api';

const timestamp = '2026-09-10T12:00:00Z';
const ownerCredential = `${'A'.repeat(42)}A`;
const retention = {
  retentionDecision: 'deny' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: '2026-09-10T13:00:00Z',
  freshUntil: '2026-09-10T13:00:00Z',
  displayUntil: '2026-09-10T13:00:00Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only' as const,
  policyStatus: 'policy_withheld' as const,
  displayPolicyStatus: 'available' as const,
};
const message = {
  text: '候補を確認しました',
  evidenceIds: [],
  evidence: [],
  basis: 'conversational' as const,
  retention,
};

const searchResponse = (requestId: string, threadId: string, revision: number) => ({
  requestId,
  response: {
    schemaVersion: 'v1' as const,
    threadId,
    turnId: 'turn-1',
    responseId: `response-${revision}`,
    revision,
    kind: 'message' as const,
    presentation: 'keep' as const,
    cardSetId: null,
    message: [message],
  },
  warnings: [],
});

const searchInput: SearchRequest = {
  schemaVersion: 'v1',
  requestId: 'request-search',
  threadId: 'thread-1',
  turnId: null,
  revision: 1,
  text: '静かな店',
  clientNow: timestamp,
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
    areaText: null,
    budget: 'any',
  },
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: 'idempotency-search',
};

const turnInput: ThreadTurnRequest = {
  schemaVersion: searchInput.schemaVersion,
  requestId: 'request-turn',
  text: searchInput.text,
  clientNow: searchInput.clientNow,
  location: searchInput.location,
  prefs: searchInput.prefs,
  savedPlaceRefs: searchInput.savedPlaceRefs,
  excludeCandidateIds: searchInput.excludeCandidateIds,
  mode: searchInput.mode,
  turnId: 'turn-1',
  revision: 2,
  idempotencyKey: 'idempotency-turn',
};

const createInput: CreateThreadRequest = {
  schemaVersion: 'v1',
  requestId: 'request-create',
  idempotencyKey: 'idempotency-create',
};

const lifecycleInput: LifecycleCommand = {
  schemaVersion: 'v1',
  requestId: 'request-life',
  turnId: 'turn-1',
  revision: 3,
  idempotencyKey: 'idempotency-life',
};

const optionsFor = (
  fetchImpl: ApiFetch,
  requestIdFactory = (): string => 'request-read',
): ApiClientOptions => ({
  baseUrl: 'http://localhost:8787',
  mode: 'fixture',
  appVersion: 'test',
  credentials: { appToken: 'app-token', deviceId: 'device-1', ownerCredential },
  requestIdFactory,
  fetchImpl,
});

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const readSnapshot = (requestId: string, threadId = 'thread-1') => ({
  schemaVersion: 'v1' as const,
  requestId,
  threadId,
  revision: 3,
  active: true,
  responses: [
    {
      responseId: 'response-1',
      turnId: 'turn-1',
      revision: 1,
      kind: 'message' as const,
      presentation: 'keep' as const,
      cardSetId: null,
      restoreMode: 'unavailable' as const,
    },
  ],
});

describe('Journey API transport', () => {
  it('uses the shared envelope for every first-unit route', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    let readRequest = 0;
    const fetchImpl: ApiFetch = async (input, init) => {
      await Promise.resolve();
      const requestInit = init ?? {};
      calls.push({ url: requestUrl(input), init: requestInit });
      const url = new URL(requestUrl(input));
      const body =
        typeof requestInit.body === 'string'
          ? (JSON.parse(requestInit.body) as {
              readonly requestId?: string;
              readonly revision?: number;
            })
          : undefined;
      const requestId =
        body?.requestId ??
        new Headers(requestInit.headers).get(REQUEST_ID_HEADER) ??
        `request-read-${++readRequest}`;
      if (url.pathname === '/v1/search') {
        return Response.json(searchResponse(requestId, 'thread-1', 2));
      }
      if (requestInit.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.pathname === '/v1/threads') {
        return Response.json(
          { schemaVersion: 'v1', requestId, threadId: 'thread-1', revision: 1, state: 'active' },
          { status: 201 },
        );
      }
      if (url.pathname.endsWith('/turns')) {
        return Response.json(searchResponse(requestId, 'thread-1', (body?.revision ?? 2) + 1));
      }
      if (url.pathname.endsWith('/replay') || requestInit.method === 'GET') {
        return Response.json(readSnapshot(requestId));
      }
      return Response.json({
        schemaVersion: 'v1',
        requestId,
        threadId: 'thread-1',
        turnId: 'turn-1',
        revision: 4,
        state: 'cancelled',
      });
    };
    const client = createJourneyApiClient(optionsFor(fetchImpl));

    expect((await client.search(searchInput)).ok).toBe(true);
    expect((await client.createThread(createInput)).ok).toBe(true);
    expect((await client.turn('thread-1', turnInput)).ok).toBe(true);
    expect((await client.readThread('thread-1')).ok).toBe(true);
    expect((await client.replayThread('thread-1')).ok).toBe(true);
    expect((await client.lifecycle('cancel', 'thread-1', lifecycleInput)).ok).toBe(true);
    expect((await client.deleteThread('thread-1', lifecycleInput)).ok).toBe(true);

    const searchCall = calls.find((call) => new URL(call.url).pathname === '/v1/search');
    expect(searchCall?.init.headers).toMatchObject({
      [APP_TOKEN_HEADER]: 'app-token',
      [REQUEST_ID_HEADER]: searchInput.requestId,
    });
    const searchBody = searchCall?.init.body;
    expect(typeof searchBody === 'string' ? JSON.parse(searchBody) : null).toMatchObject({
      requestId: searchInput.requestId,
    });
    expect(calls.every((call) => call.init.redirect === 'error')).toBe(true);
  });

  it('rejects malformed, cross-thread, and mismatched error envelopes', async () => {
    let response: Response = Response.json({ nope: true });
    const fetchImpl: ApiFetch = () => Promise.resolve(response);
    const client = createJourneyApiClient(optionsFor(fetchImpl));

    const invalidSearch = { ...searchInput, unexpected: true } as unknown as SearchRequest;
    expect(await client.search(invalidSearch)).toMatchObject({
      ok: false,
      error: { kind: 'contract', route: 'search', status: null },
    });
    const invalidTurn = {
      ...searchInput,
      requestId: 'request-turn',
    } as unknown as ThreadTurnRequest;
    expect(await client.turn('thread-1', invalidTurn)).toMatchObject({
      ok: false,
      error: { kind: 'contract', route: 'turn', status: null },
    });

    const malformed = await client.search(searchInput);
    expect(malformed).toMatchObject({ ok: false, error: { kind: 'contract', status: 200 } });

    response = Response.json(searchResponse(searchInput.requestId, 'other-thread', 2));
    const wrongThread = await client.search(searchInput);
    expect(wrongThread).toMatchObject({ ok: false, error: { kind: 'contract' } });

    response = Response.json(searchResponse('other-request', 'thread-1', 2));
    const wrongRequest = await client.search(searchInput);
    expect(wrongRequest).toMatchObject({ ok: false, error: { kind: 'contract' } });

    response = Response.json(searchResponse(searchInput.requestId, 'thread-1', 1));
    const oldRevision = await client.search(searchInput);
    expect(oldRevision).toMatchObject({ ok: false, error: { kind: 'contract' } });

    response = Response.json({
      ...searchResponse(turnInput.requestId, 'thread-1', 3),
      response: {
        ...searchResponse(turnInput.requestId, 'thread-1', 3).response,
        turnId: 'other-turn',
      },
    });
    const wrongTurn = await client.turn('thread-1', turnInput);
    expect(wrongTurn).toMatchObject({ ok: false, error: { kind: 'contract' } });

    response = Response.json({
      schemaVersion: 'v1',
      requestId: lifecycleInput.requestId,
      threadId: 'thread-1',
      turnId: null,
      revision: 4,
      state: 'cancelled',
    });
    const missingTurnCorrelation = await client.lifecycle('cancel', 'thread-1', lifecycleInput);
    expect(missingTurnCorrelation).toMatchObject({
      ok: false,
      error: { kind: 'contract' },
    });

    response = Response.json(
      {
        schemaVersion: 'v1',
        requestId: searchInput.requestId,
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required.',
      },
      { status: 401 },
    );
    const unauthorized = await client.search(searchInput);
    expect(unauthorized).toMatchObject({ ok: false, error: { kind: 'http', status: 401 } });

    response = Response.json(
      {
        schemaVersion: 'v1',
        requestId: searchInput.requestId,
        status: 429,
        code: 'RATE_LIMITED',
        message: 'Too many requests.',
      },
      { status: 429, headers: { 'retry-after': '12' } },
    );
    const limited = await client.search(searchInput);
    expect(limited).toMatchObject({
      ok: false,
      error: { kind: 'http', status: 429, retryAfterSeconds: 12 },
    });
  });

  it.each([
    ['search', 65_000],
    ['turn', 65_000],
    ['readThread', 15_000],
  ] as const)(
    'waits for the %s deadline and then cancels the request',
    async (route, deadlineMs) => {
      vi.useFakeTimers();
      try {
        let signal: AbortSignal | null | undefined;
        const client = createJourneyApiClient(
          optionsFor((_url, init) => {
            signal = init?.signal;
            return new Promise<Response>(() => undefined);
          }),
        );
        const pending =
          route === 'search'
            ? client.search(searchInput)
            : route === 'turn'
              ? client.turn('thread-1', turnInput)
              : client.readThread('thread-1');
        const settled = vi.fn();
        const observed = pending.then(settled);
        await vi.advanceTimersByTimeAsync(deadlineMs - 1);
        expect(settled).not.toHaveBeenCalled();
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({ ok: false, error: { kind: 'timeout' } });
        await observed;
        expect(signal?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('bounds credentials, body reading, offline fetches, and external aborts', async () => {
    const never = new Promise<Response>(() => undefined);
    const timeoutClient = createJourneyApiClient({
      ...optionsFor(() => never),
      timeoutMs: 5,
    });
    await expect(timeoutClient.search(searchInput)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    });

    const hangingBody = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => new Promise<never>(() => undefined),
    } as unknown as Response;
    const bodyTimeoutClient = createJourneyApiClient({
      ...optionsFor(() => Promise.resolve(hangingBody)),
      timeoutMs: 5,
    });
    await expect(bodyTimeoutClient.search(searchInput)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    });

    const credentialTimeoutClient = createJourneyApiClient({
      ...optionsFor(() => Promise.resolve(new Response())),
      credentials: async () => await new Promise<never>(() => undefined),
      timeoutMs: 5,
    });
    await expect(credentialTimeoutClient.search(searchInput)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    });

    const controller = new AbortController();
    const abortClient = createJourneyApiClient(optionsFor(() => never));
    const aborted = abortClient.search(searchInput, { signal: controller.signal });
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ ok: false, error: { kind: 'aborted' } });

    const credentialController = new AbortController();
    const credentialAbortClient = createJourneyApiClient({
      ...optionsFor(() => Promise.resolve(new Response())),
      credentials: () => new Promise<never>(() => undefined),
    });
    const credentialAborted = credentialAbortClient.search(searchInput, {
      signal: credentialController.signal,
    });
    credentialController.abort();
    await expect(credentialAborted).resolves.toMatchObject({
      ok: false,
      error: { kind: 'aborted' },
    });

    const offlineClient = createJourneyApiClient(
      optionsFor(() => Promise.reject(new Error('offline'))),
    );
    await expect(offlineClient.search(searchInput)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'offline' },
    });
  });

  it('requires HTTPS for live mode and local HTTP for fixtures', async () => {
    const fetchImpl: ApiFetch = () =>
      Promise.resolve(Response.json(searchResponse('request-search', 'thread-1', 2)));
    const live = createJourneyApiClient({ ...optionsFor(fetchImpl), mode: 'live' });
    await expect(live.search(searchInput)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'configuration', reason: 'invalid_base_url' },
    });
    const remoteFixture = createJourneyApiClient({
      ...optionsFor(fetchImpl),
      baseUrl: 'http://example.test',
    });
    await expect(remoteFixture.search(searchInput)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'configuration', reason: 'invalid_base_url' },
    });
  });
});
