import { describe, expect, it, vi } from 'vitest';
import {
  parseSearchResponse,
  type CreateThreadRequest,
  type CreateThreadResponse,
  type PublicMessage,
  type SearchRequest,
  type SearchResponse,
  type ThreadReadResponse,
} from '@ima/contracts';
import type { JourneyApiSubmitContext } from './journey-api-binding';
import { createJourneyApiController } from './journey-controller';
import { createJourneyApiRequestFactory } from './mobile-runtime';
import type { ApiResult, JourneyApiClient } from './types';

const contextFor = (savedPlaceRefs: readonly string[]): JourneyApiSubmitContext => ({
  conditions: {
    stationLabel: '新宿',
    stationSupport: 'supported',
    maxWalkMinutes: 12,
    budget: 'normal',
  },
  removedChipLabels: [],
  cardSetId: null,
  promotedCandidateId: null,
  selectedCandidateId: null,
  candidateOrder: [],
  savedPlaceRefs,
  excludeCandidateIds: [],
});

const success = <T>(requestId: string, data: T): ApiResult<T> => ({
  ok: true,
  requestId,
  data,
});

const offline = <T>(requestId: string): ApiResult<T> => ({
  ok: false,
  requestId,
  error: { kind: 'offline' },
});

const message: PublicMessage = {
  text: '保存候補を確認しました',
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
};

const responseFor = (threadId: string, revision: number): SearchResponse => ({
  requestId: `response-request-${threadId}-${revision}`,
  response: {
    schemaVersion: 'v1',
    threadId,
    turnId: `turn-${revision}`,
    responseId: `response-${threadId}-${revision}`,
    revision,
    kind: 'message',
    presentation: 'keep',
    cardSetId: null,
    message: [message],
  },
  warnings: [],
});

const createThreadResponse = (requestId: string): CreateThreadResponse => ({
  schemaVersion: 'v1',
  requestId,
  threadId: 'thread-1',
  revision: 0,
  state: 'active',
});

const emptyThreadSnapshot = (threadId: string): ThreadReadResponse => ({
  schemaVersion: 'v1',
  requestId: `read-${threadId}`,
  threadId,
  revision: 1,
  active: true,
  responses: [],
});

const unexpectedApiCall = (): Promise<never> => Promise.reject(new Error('unexpected API call'));

const apiWith = (overrides: Partial<JourneyApiClient> = {}): JourneyApiClient => ({
  mode: 'fixture',
  createThread: vi.fn((input: CreateThreadRequest) =>
    Promise.resolve(success(input.requestId, createThreadResponse(input.requestId))),
  ),
  search: vi.fn((input: SearchRequest) =>
    Promise.resolve(success(input.requestId, responseFor(input.threadId, 1))),
  ),
  turn: unexpectedApiCall,
  readThread: vi.fn((threadId: string) =>
    Promise.resolve(success(`read-${threadId}`, emptyThreadSnapshot(threadId))),
  ),
  replayThread: unexpectedApiCall,
  lifecycle: unexpectedApiCall,
  deleteThread: unexpectedApiCall,
  createSavedReference: unexpectedApiCall,
  deleteSavedReference: unexpectedApiCall,
  refreshSavedReference: unexpectedApiCall,
  ...overrides,
});

const requestFactory = () => {
  let sequence = 0;
  return createJourneyApiRequestFactory({
    now: () => '2026-09-10T10:00:00.000Z',
    idFactory: (prefix) => `${prefix}-${++sequence}`,
  });
};

describe('saved references in mobile runtime requests', () => {
  it('retries the same controller operation with the same saved references', async () => {
    expect(parseSearchResponse(responseFor('thread-1', 1)).success).toBe(true);
    let attempts = 0;
    const search = vi.fn((input: SearchRequest): Promise<ApiResult<SearchResponse>> => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1
          ? offline<SearchResponse>(input.requestId)
          : success(input.requestId, responseFor(input.threadId, 1)),
      );
    });
    const api = apiWith({ search });
    const controller = createJourneyApiController({ api });
    const requests = requestFactory();

    await expect(controller.createThread(requests.createThread())).resolves.toMatchObject({
      ok: true,
    });
    const request = requests.search({
      threadId: 'thread-1',
      revision: 0,
      query: '保存候補を確認',
      context: contextFor(['saved-place-retry']),
    });

    await expect(controller.search(request)).resolves.toMatchObject({ ok: false });
    await expect(controller.retry()).resolves.toMatchObject({ ok: true });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[0]?.[0].savedPlaceRefs).toEqual(['saved-place-retry']);
    expect(search.mock.calls[1]?.[0].savedPlaceRefs).toEqual(['saved-place-retry']);
  });

  it('does not apply saved references from a late request after switching threads', async () => {
    let resolveOld: ((result: ApiResult<SearchResponse>) => void) | undefined;
    const oldSearch = new Promise<ApiResult<SearchResponse>>((resolve) => {
      resolveOld = resolve;
    });
    const search = vi.fn((input: SearchRequest): Promise<ApiResult<SearchResponse>> =>
      input.threadId === 'thread-1'
        ? oldSearch
        : Promise.resolve(success(input.requestId, responseFor('thread-2', input.revision + 1))),
    );
    const api = apiWith({ search });
    const controller = createJourneyApiController({ api });
    const requests = requestFactory();

    await expect(controller.createThread(requests.createThread())).resolves.toMatchObject({
      ok: true,
    });
    const oldRequest = requests.search({
      threadId: 'thread-1',
      revision: 0,
      query: '古い会話の保存候補',
      context: contextFor(['saved-place-old']),
    });
    const oldResult = controller.search(oldRequest);

    await expect(controller.readThread('thread-2')).resolves.toMatchObject({ ok: true });
    resolveOld?.(success(oldRequest.requestId, responseFor('thread-1', 1)));
    await expect(oldResult).resolves.toMatchObject({
      ok: false,
      error: { kind: 'contract' },
    });

    const newRequest = requests.search({
      threadId: 'thread-2',
      revision: 1,
      query: '新しい会話の保存候補',
      context: contextFor(['saved-place-new']),
    });
    await expect(controller.search(newRequest)).resolves.toMatchObject({ ok: true });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.map(([input]) => input.savedPlaceRefs)).toEqual([
      ['saved-place-old'],
      ['saved-place-new'],
    ]);
    expect(controller.getState()).toMatchObject({ threadId: 'thread-2', status: 'idle' });
  });
});
