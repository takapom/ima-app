import { describe, expect, it } from 'vitest';
import type { CancellationToken, HarnessContext, ToolExecutionContext } from '@ima/core';
import { createPlacesSearchAdapter } from '../../../src/providers/places-search/adapter';
import { GoogleTextSearchError } from '../../../src/providers/places-search/types';

const context: HarnessContext = {
  threadId: 'thread-error',
  turnId: 'turn-error',
  revision: 1,
  serverNow: '2026-09-10T02:00:00.000Z',
  ownerScopeRef: 'owner-error',
  location: {
    status: 'unavailable',
    coordinates: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
    revision: 1,
  },
  preferences: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: null,
    budget: 'any',
  },
  budget: {
    wallClockMs: 5_000,
    finalReserveMs: 500,
    modelCallsRemaining: 1,
    readCallsRemaining: 1,
    providerHttpRequestsRemaining: 1,
    retriesRemaining: 0,
  },
  capabilities: {
    version: 'places-search-v1',
    detailFields: [],
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['thread'],
  },
};

const execution: ToolExecutionContext = {
  callId: 'call-error',
  operation: 'search_places',
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
};

const input = {
  mode: 'search' as const,
  query: '静かなカフェ',
  area: { kind: 'named_area' as const, name: '渋谷' },
  openNow: true,
  limit: 2,
  excludeCandidateIds: [],
};

const cancellation: CancellationToken = { isCancelled: () => false };

describe('Places search adapter provider failures', () => {
  it('keeps typed provider failures distinct from an empty successful page', async () => {
    const adapter = createPlacesSearchAdapter({
      transport: {
        search: () =>
          Promise.reject(new GoogleTextSearchError('RATE_LIMITED', { retryAfterMs: 1_250 })),
      },
      continuation: {
        issue: () => Promise.resolve('cursor-1'),
        resolve: () => Promise.resolve({ ok: false, code: 'INVALID_CURSOR' as const }),
      },
      registration: {
        registerCandidate: () => {
          throw new Error('must not register after provider failure');
        },
        registerObservation: () => {
          throw new Error('must not register after provider failure');
        },
      },
      nextSearchId: () => 'search-error',
      clock: () => context.serverNow,
      normalizeOpeningHours: () => ({ status: 'unknown', reason: 'fixture' }),
    });
    const result = await adapter.search(input, context, execution, cancellation);
    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'RATE_LIMITED', retryAfterMs: 1_250 },
    });
  });
});
