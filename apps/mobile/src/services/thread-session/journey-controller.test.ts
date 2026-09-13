import { describe, expect, it, vi } from 'vitest';
import type {
  AssistantMessageResponse,
  CreateThreadRequest,
  CreateThreadResponse,
  LifecycleCommand,
  LocationSnapshot,
  Preferences,
  PublicMessage,
  SearchRequest,
  SearchResponse,
  ThreadReadResponse,
  ThreadTurnRequest,
} from '@ima/contracts';
import { createJourneyApiController, type JourneyLocalSnapshot } from './journey-controller';
import type { ApiRequestOptions, ApiResult, JourneyApiClient, LifecycleResponse } from '../api/api';
const message = {
  text: '候補を確認しました',
  evidenceIds: [],
  evidence: [],
  basis: 'conversational',
  retention: {
    retentionDecision: 'deny',
    retentionMode: 'session_only',
    sessionExpiresAt: '2026-09-10T13:00:00Z',
    freshUntil: '2026-09-10T13:00:00Z',
    displayUntil: '2026-09-10T13:00:00Z',
    retentionUntil: null,
    deletionScheduledAt: null,
    attribution: null,
    restoreMode: 'reference_only',
    policyStatus: 'policy_withheld',
    displayPolicyStatus: 'available',
  },
} as PublicMessage;
const response = (threadId: string, turnId: string, responseId: string, revision: number) =>
  ({
    schemaVersion: 'v1',
    threadId,
    turnId,
    responseId,
    revision,
    kind: 'message',
    presentation: 'keep',
    cardSetId: null,
    message: [message],
  }) as AssistantMessageResponse;
const searchResponse = (requestId: string, value: AssistantMessageResponse): SearchResponse => ({
  requestId,
  response: value,
  warnings: [],
});
const ok = <T>(requestId: string, data: T): ApiResult<T> => ({ ok: true, requestId, data });
const createInput = (key = 'create-1'): CreateThreadRequest => ({
  schemaVersion: 'v1',
  requestId: `request-${key}`,
  idempotencyKey: key,
});
const location: LocationSnapshot = {
  status: 'unavailable',
  lat: null,
  lng: null,
  accuracyMeters: null,
  precise: false,
  capturedAt: null,
};
const prefs: Preferences = {
  homeStationRef: null,
  maxWalkMinutes: null,
  minimumStayMinutes: null,
  areaText: null,
  budget: null,
};
const searchInput = (
  threadId: string,
  revision: number,
  turnId: string | null = null,
  key = `search-${revision}`,
): SearchRequest => ({
  schemaVersion: 'v1',
  requestId: `request-${key}`,
  threadId,
  turnId,
  revision,
  text: '静かな店',
  clientNow: '2026-09-10T10:00:00.000Z',
  location,
  prefs,
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: key,
});
const turnInput = (revision: number, key = `turn-${revision}`): ThreadTurnRequest => ({
  schemaVersion: 'v1',
  requestId: `request-${key}`,
  turnId: 'turn-1',
  revision,
  text: 'もう少し駅に近い店',
  clientNow: '2026-09-10T10:00:00.000Z',
  location,
  prefs,
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: key,
});
const lifecycleInput = (revision: number): LifecycleCommand => ({
  schemaVersion: 'v1',
  requestId: `request-cancel-${revision}`,
  turnId: 'turn-1',
  revision,
  idempotencyKey: `cancel-${revision}`,
});
const createThreadResponse = (requestId: string, threadId: string): CreateThreadResponse => ({
  schemaVersion: 'v1',
  requestId,
  threadId,
  revision: 0,
  state: 'active',
});

const lifecycleResponse = (
  requestId: string,
  threadId: string,
  revision: number,
): LifecycleResponse => ({
  schemaVersion: 'v1',
  requestId,
  threadId,
  turnId: 'turn-1',
  revision,
  state: 'cancelled',
});
const referenceSnapshot = (threadId: string, revision: number): ThreadReadResponse => ({
  schemaVersion: 'v1',
  requestId: 'request-history',
  threadId,
  revision,
  active: true,
  responses: [
    {
      responseId: 'response-reference',
      turnId: 'turn-1',
      revision,
      kind: 'message',
      presentation: 'keep',
      cardSetId: null,
      restoreMode: 'reference_only',
    },
  ],
});

const apiWith = (overrides: Partial<JourneyApiClient> = {}): JourneyApiClient =>
  ({
    mode: 'fixture',
    createThread: vi.fn((input: CreateThreadRequest) =>
      Promise.resolve(ok(input.requestId, createThreadResponse(input.requestId, 'thread-1'))),
    ),
    search: vi.fn((input: SearchRequest) =>
      Promise.resolve(
        ok(
          input.requestId,
          searchResponse(input.requestId, response(input.threadId, 'turn-1', 'response-1', 1)),
        ),
      ),
    ),
    turn: vi.fn((threadId: string, input: ThreadTurnRequest) =>
      Promise.resolve(
        ok(
          input.requestId,
          searchResponse(input.requestId, response(threadId, 'turn-1', 'response-2', 2)),
        ),
      ),
    ),
    readThread: vi.fn((threadId: string) =>
      Promise.resolve(ok('request-read', referenceSnapshot(threadId, 2))),
    ),
    replayThread: vi.fn((threadId: string) =>
      Promise.resolve(ok('request-replay', referenceSnapshot(threadId, 2))),
    ),
    lifecycle: vi.fn(
      (
        _action: 'cancel' | 'resume' | 'restart' | 'end',
        threadId: string,
        input: LifecycleCommand,
      ) =>
        Promise.resolve(
          ok(input.requestId, lifecycleResponse(input.requestId, threadId, input.revision + 1)),
        ),
    ),
    deleteThread: vi.fn(),
    ...overrides,
  }) as unknown as JourneyApiClient;

const localSnapshot: JourneyLocalSnapshot = {
  threadId: 'thread-1',
  responseId: 'response-local',
  revision: 2,
  restoreMode: 'reference_only',
  updatedAt: '2026-09-10T10:00:00.000Z',
  sessionExpiresAt: '2026-09-10T13:00:00.000Z',
  displayUntil: '2026-09-10T13:00:00.000Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  needsRefetch: true,
};
describe('Journey API controller', () => {
  it('creates a thread, applies a derived search turn, and continues with a turn', async () => {
    const api = apiWith();
    const controller = createJourneyApiController({ api });

    await expect(controller.createThread(createInput())).resolves.toMatchObject({ ok: true });
    await expect(controller.search(searchInput('thread-1', 0))).resolves.toMatchObject({
      ok: true,
    });
    expect(controller.getState()).toMatchObject({
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      status: 'idle',
      responseState: { revision: 1 },
    });

    await expect(controller.turn('thread-1', turnInput(1))).resolves.toMatchObject({ ok: true });
    expect(controller.getState().responseState?.responseRecords).toHaveLength(2);
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.turn).toHaveBeenCalledTimes(1);
  });
  it('deduplicates an in-flight search and ignores its response after history switches', async () => {
    let resolveSearch: ((value: ApiResult<SearchResponse>) => void) | undefined;
    const pendingSearch = new Promise<ApiResult<SearchResponse>>((resolve) => {
      resolveSearch = resolve;
    });
    const api = apiWith({
      search: vi.fn(() => pendingSearch),
      readThread: vi.fn(() =>
        Promise.resolve(ok('request-history', referenceSnapshot('thread-2', 1))),
      ),
    });
    const controller = createJourneyApiController({ api });
    await controller.createThread(createInput());
    const input = searchInput('thread-1', 0, null, 'same-search');
    const first = controller.search(input);
    const duplicate = controller.search(input);
    expect(duplicate).toBe(first);

    await controller.readThread('thread-2');
    resolveSearch?.(
      ok(
        input.requestId,
        searchResponse(input.requestId, response('thread-1', 'turn-1', 'late', 1)),
      ),
    );
    await expect(first).resolves.toMatchObject({ ok: false, error: { kind: 'contract' } });
    expect(controller.getState()).toMatchObject({
      threadId: 'thread-2',
      responseState: { threadId: 'thread-2' },
    });
    expect(controller.getState().responseState?.responseRecords).toHaveLength(0);
  });

  it('rejects a missing server-derived turn ID even when the request turn ID was null', async () => {
    const api = apiWith({
      search: vi.fn((input: SearchRequest) =>
        Promise.resolve(
          ok(
            input.requestId,
            searchResponse(input.requestId, {
              ...response('thread-1', 'turn-1', 'invalid-turn', 1),
              turnId: null,
            } as unknown as AssistantMessageResponse),
          ),
        ),
      ),
    });
    const controller = createJourneyApiController({ api });
    await controller.createThread(createInput());
    await expect(controller.search(searchInput('thread-1', 0))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'contract' },
    });
    expect(controller.getState().responseState?.responseRecords).toHaveLength(0);
  });

  it('retries a failed turn and cancels a pending turn without applying the late response', async () => {
    let rejectTurn: ((value: ApiResult<SearchResponse>) => void) | undefined;
    const api = apiWith({
      turn: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          requestId: 'request-turn-1',
          error: { kind: 'offline' },
        })
        .mockResolvedValueOnce(
          ok(
            'request-turn-1',
            searchResponse('request-turn-1', response('thread-1', 'turn-1', 'response-2', 2)),
          ),
        )
        .mockImplementationOnce(() => new Promise((resolve) => (rejectTurn = resolve))),
      lifecycle: vi.fn(
        (
          _action: 'cancel' | 'resume' | 'restart' | 'end',
          threadId: string,
          input: LifecycleCommand,
        ) => Promise.resolve(ok(input.requestId, lifecycleResponse(input.requestId, threadId, 2))),
      ),
    });
    const controller = createJourneyApiController({ api });
    await controller.createThread(createInput());
    await controller.search(searchInput('thread-1', 0));

    await expect(controller.turn('thread-1', turnInput(1))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'offline' },
    });
    expect(controller.getState().status).toBe('error');
    await expect(controller.retry()).resolves.toMatchObject({ ok: true });
    expect(controller.getState().responseState?.revision).toBe(2);

    const pending = controller.turn('thread-1', turnInput(2, 'turn-cancel'));
    await Promise.resolve();
    await expect(controller.cancel('thread-1', lifecycleInput(2))).resolves.toMatchObject({
      ok: true,
    });
    rejectTurn?.(
      ok(
        'request-turn-cancel',
        searchResponse('request-turn-cancel', response('thread-1', 'turn-1', 'late-cancel', 3)),
      ),
    );
    await expect(pending).resolves.toMatchObject({ ok: false, error: { kind: 'contract' } });
    expect(controller.getState()).toMatchObject({
      status: 'cancelled',
      responseState: { revision: 2 },
    });
  });

  it('keeps a local reference-only snapshot until server history replaces it', async () => {
    const api = apiWith({
      readThread: vi.fn(() =>
        Promise.resolve(ok('request-history', referenceSnapshot('thread-1', 2))),
      ),
      replayThread: vi.fn(() =>
        Promise.resolve(ok('request-replay', referenceSnapshot('thread-1', 2))),
      ),
    });
    const controller = createJourneyApiController({
      api,
      localRestore: { readSnapshot: () => localSnapshot },
      clock: () => '2026-09-10T12:00:00.000Z',
    });
    await expect(controller.restoreLocal('thread-1')).resolves.toEqual({
      status: 'restored',
      snapshot: localSnapshot,
    });
    expect(controller.getState()).toMatchObject({
      localSnapshot,
      responseState: { revision: 2, cards: null },
    });

    await expect(controller.readThread('thread-1')).resolves.toMatchObject({ ok: true });
    expect(controller.getState()).toMatchObject({
      localSnapshot: null,
      responseState: { revision: 2 },
      status: 'idle',
    });
    expect(controller.getState().responseState?.restoreStatuses).toHaveLength(1);
    await expect(controller.replayThread('thread-1')).resolves.toMatchObject({ ok: true });
  });

  it('aborts invalidated history reads and keeps current candidates after a read failure', async () => {
    let resolveRead: ((value: ApiResult<ThreadReadResponse>) => void) | undefined;
    let readSignal: AbortSignal | undefined;
    const pendingRead = new Promise<ApiResult<ThreadReadResponse>>((resolve) => {
      resolveRead = resolve;
    });
    const readThread = vi.fn(
      (_threadId: string, options?: ApiRequestOptions): Promise<ApiResult<ThreadReadResponse>> => {
        readSignal = options?.signal;
        return pendingRead;
      },
    );
    const api = apiWith({ readThread });
    const controller = createJourneyApiController({ api });
    await controller.createThread(createInput());
    await controller.search(searchInput('thread-1', 0));
    const pending = controller.readThread('thread-1');
    await Promise.resolve();
    expect(readSignal?.aborted).toBe(false);
    resolveRead?.({ ok: false, requestId: 'request-read', error: { kind: 'offline' } });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { kind: 'offline' } });
    expect(controller.getState()).toMatchObject({
      status: 'error',
      responseState: { revision: 1 },
    });

    let resolveLateRead: ((value: ApiResult<ThreadReadResponse>) => void) | undefined;
    const lateRead = new Promise<ApiResult<ThreadReadResponse>>((resolve) => {
      resolveLateRead = resolve;
    });
    const nextRead = vi.fn(
      (_threadId: string, options?: ApiRequestOptions): Promise<ApiResult<ThreadReadResponse>> => {
        readSignal = options?.signal;
        return lateRead;
      },
    );
    readThread.mockImplementation(nextRead);
    const switching = controller.readThread('thread-1');
    const local = controller.restoreLocal('thread-2');
    await local;
    expect(readSignal?.aborted).toBe(true);
    resolveLateRead?.(ok('request-read', referenceSnapshot('thread-1', 2)));
    await expect(switching).resolves.toMatchObject({ ok: false, error: { kind: 'contract' } });
    expect(controller.getState().threadId).toBe('thread-2');
  });

  it('does not let an older same-thread snapshot replace a turn that arrived while reading', async () => {
    let resolveRead: ((value: ApiResult<ThreadReadResponse>) => void) | undefined;
    const pendingRead = new Promise<ApiResult<ThreadReadResponse>>((resolve) => {
      resolveRead = resolve;
    });
    let resolveTurn: ((value: ApiResult<SearchResponse>) => void) | undefined;
    const pendingTurn = new Promise<ApiResult<SearchResponse>>((resolve) => {
      resolveTurn = resolve;
    });
    const api = apiWith({
      readThread: vi.fn(() => pendingRead),
      turn: vi.fn(() => pendingTurn),
    });
    const controller = createJourneyApiController({ api });
    await controller.createThread(createInput());
    await controller.search(searchInput('thread-1', 0));
    const reading = controller.readThread('thread-1');
    await Promise.resolve();
    const turning = controller.turn('thread-1', turnInput(1, 'turn-during-read'));
    await Promise.resolve();
    resolveRead?.(ok('request-read', referenceSnapshot('thread-1', 2)));

    await expect(reading).resolves.toMatchObject({
      ok: false,
      error: { kind: 'contract' },
    });
    resolveTurn?.(
      ok(
        'request-turn-during-read',
        searchResponse(
          'request-turn-during-read',
          response('thread-1', 'turn-1', 'response-new', 2),
        ),
      ),
    );
    await expect(turning).resolves.toMatchObject({ ok: true });
    expect(controller.getState()).toMatchObject({
      status: 'idle',
      responseState: { revision: 2 },
    });
    expect(controller.getState().responseState?.responseRecords).toHaveLength(2);
  });

  it('settles a stale history read as an error while preserving current candidates', async () => {
    const api = apiWith({
      readThread: vi.fn(() =>
        Promise.resolve(ok('request-old-history', referenceSnapshot('thread-1', 1))),
      ),
    });
    const controller = createJourneyApiController({ api });
    await controller.createThread(createInput());
    await controller.search(searchInput('thread-1', 0));
    await controller.turn('thread-1', turnInput(1));

    await expect(controller.readThread('thread-1')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'contract' },
    });
    expect(controller.getState()).toMatchObject({
      status: 'error',
      responseState: { revision: 2 },
    });
  });

  it('rejects a reference that expires while the local restore is awaiting storage', async () => {
    let now = '2026-09-10T12:59:59.000Z';
    let resolveSnapshot: ((value: JourneyLocalSnapshot) => void) | undefined;
    const restoring = new Promise<JourneyLocalSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const controller = createJourneyApiController({
      api: apiWith(),
      localRestore: { readSnapshot: () => restoring },
      clock: () => now,
    });
    const pending = controller.restoreLocal('thread-1');
    now = '2026-09-10T13:00:00.000Z';
    resolveSnapshot?.(localSnapshot);
    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'read_failed' });
    expect(controller.getState().error?.kind).toBe('contract');
  });
});
