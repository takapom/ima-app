import { describe, expect, it } from 'vitest';
import type { HarnessContext, ToolExecutionContext } from '@ima/core';
import {
  createGoogleWalkingRouteAdapter,
  createRuntimeRouteBudgetBoundary,
} from '../../../src/providers/routes/adapter';
import { createGoogleRouteMatrixTransport } from '../../../src/providers/routes/transport';
import { DEFAULT_RUNTIME_BUDGET, RuntimeBudget } from '../../../src/runtime/runtime-budget';

const now = '2026-09-10T09:00:00.000Z';
const currentCoordinates = { lat: 35.6595, lng: 139.7005 };

const context: HarnessContext = {
  threadId: 'thread-matrix-conflict',
  turnId: 'turn-matrix-conflict',
  revision: 2,
  serverNow: now,
  ownerScopeRef: 'owner-matrix-conflict',
  location: {
    status: 'available',
    coordinates: currentCoordinates,
    accuracyMeters: 50,
    precise: true,
    capturedAt: '2026-09-10T08:59:00.000Z',
    revision: 2,
  },
  preferences: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: null,
    budget: 'any',
  },
  budget: {
    wallClockMs: 12_000,
    finalReserveMs: 2_000,
    modelCallsRemaining: 6,
    readCallsRemaining: 8,
    providerHttpRequestsRemaining: 20,
    retriesRemaining: 1,
  },
  capabilities: {
    version: 'v1',
    detailFields: ['walking_route'],
    walkingRoute: true,
    lastTrain: false,
    supportedScopes: ['thread'],
  },
};

const execution: ToolExecutionContext = {
  callId: 'call-matrix-conflict',
  operation: 'walking_route',
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
};

describe('walking route matrix structural failures', () => {
  it('returns invalid argument instead of dropping a conflicting leg beside a valid group', async () => {
    let providerCalls = 0;
    const budget = new RuntimeBudget({
      config: { ...DEFAULT_RUNTIME_BUDGET, maxCostUnits: 4 },
      startedAtMs: 0,
      now: () => 1,
    });
    const transport = createGoogleRouteMatrixTransport({
      apiKey: 'test-key',
      fetcher: () => {
        providerCalls += 1;
        return Promise.resolve(new Response('[]', { status: 200 }));
      },
    });
    const adapter = createGoogleWalkingRouteAdapter({
      transport,
      budget: createRuntimeRouteBudgetBoundary(budget),
      clock: () => now,
      resolveContext: () => context,
      waypointResolver: {
        resolveCandidateWaypoint: (candidateId) => ({
          ok: true,
          waypoint: {
            coordinates:
              candidateId === 'candidate-1'
                ? { lat: 35.658, lng: 139.7016 }
                : { lat: 35.657, lng: 139.702 },
          },
        }),
        resolveStationWaypoint: (stationRef) => ({
          ok: true,
          waypoint: { placeId: `station-${stationRef}` },
        }),
      },
    });

    const result = await adapter.computeDirected(
      {
        legs: [
          {
            kind: 'current_to_candidate',
            originRef: 'current',
            originCoordinates: currentCoordinates,
            originRevision: 2,
            destinationCandidateId: 'candidate-1',
          },
          {
            kind: 'candidate_to_station',
            originCandidateId: 'candidate-1',
            originRef: 'shared-origin',
            destinationStationRef: 'station-1',
          },
          {
            kind: 'candidate_to_station',
            originCandidateId: 'candidate-2',
            originRef: 'shared-origin',
            destinationStationRef: 'station-2',
          },
        ],
      },
      context,
      execution,
      { isCancelled: () => false },
    );

    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(providerCalls).toBe(0);
    expect(budget.snapshot()).toMatchObject({
      providerHttpRequests: 0,
      routeElements: 0,
    });
  });
});
