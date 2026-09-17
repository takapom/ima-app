import { describe, expect, it } from 'vitest';
import type { HarnessContext, Result, SearchPlacesOutput } from '@ima/core';
import { projectSearchResult } from '../../src/tools/projection';
import { createToolRegistry } from './registry-fixture';

const context: HarnessContext = {
  ownerScopeRef: 'owner-tools',
  threadId: 'thread-tools',
  turnId: 'turn-mixed',
  revision: 1,
  serverNow: '2026-09-10T00:00:00Z',
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
    budget: 'normal',
  },
  budget: {
    wallClockMs: 1000,
    finalReserveMs: 100,
    modelCallsRemaining: 1,
    readCallsRemaining: 1,
    providerHttpRequestsRemaining: 1,
    retriesRemaining: 0,
  },
  capabilities: {
    version: 'tools-mixed',
    detailFields: ['identity'],
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['tools-fixture'],
  },
};

const mixedResult: Result<SearchPlacesOutput> = {
  status: 'ok',
  data: {
    searchId: 'search-mixed',
    candidates: [
      {
        candidateId: 'candidate-1',
        identity: { status: 'unknown', reason: 'IDENTITY_PROVIDER_CANARY' },
        openingHours: { status: 'unsupported', reason: 'HOURS_PROVIDER_CANARY' },
        price: { status: 'not_applicable', reason: 'PRICE_PROVIDER_CANARY' },
      },
    ],
    applied: { areaDescription: '渋谷', openNow: true, excludedCount: 0 },
    nextCursor: null,
    coverage: 'provider_results',
  },
  warnings: [
    {
      code: 'UPSTREAM_UNAVAILABLE',
      path: null,
      retryable: false,
      retryAfterMs: null,
      message: 'MIXED_PROVIDER_CANARY',
      missingFields: [],
    },
  ],
};

describe('mixed model-facing tool payloads', () => {
  it('withholds provider reasons and warning payloads for unknown fields', () => {
    const result = projectSearchResult(
      mixedResult,
      context,
      createToolRegistry().registry,
      context.serverNow,
    );

    expect(result).toMatchObject({
      status: 'ok',
      data: {
        candidates: [
          {
            identity: { status: 'unknown' },
            openingHours: { status: 'unsupported' },
            price: { status: 'not_applicable' },
          },
        ],
        nextCursor: null,
      },
      warnings: [{ message: 'tool result is unavailable' }],
    });
    expect(JSON.stringify(result)).not.toContain('PROVIDER_CANARY');
  });
});
