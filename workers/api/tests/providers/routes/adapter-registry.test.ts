import { describe, expect, it } from 'vitest';
import {
  CandidateObservationRegistry,
  type HarnessContext,
  type RegistryIdPort,
  type ToolExecutionContext,
  type WalkingCoordinates,
} from '@ima/core';
import { RuntimeBudget, DEFAULT_RUNTIME_BUDGET } from '../../../src/runtime/runtime-budget';
import { createGoogleRouteMatrixTransport } from '../../../src/providers/routes/transport';
import {
  createGoogleWalkingRouteAdapter,
  createRuntimeRouteBudgetBoundary,
} from '../../../src/providers/routes/adapter';

const evaluatedAt = '2026-09-10T09:00:00.000Z';
const currentCoordinates = { lat: 35.6595, lng: 139.7005 };
const candidateCoordinates = { lat: 35.658, lng: 139.7016 };

const context: HarnessContext = {
  threadId: 'thread-registry',
  turnId: 'turn-registry',
  revision: 2,
  serverNow: evaluatedAt,
  ownerScopeRef: 'owner-registry',
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
  callId: 'call-registry',
  operation: 'walking_route',
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
};

const registryIds: RegistryIdPort = {
  nextCallId: () => 'call-registry',
  nextCandidateId: () => 'candidate-1',
  nextObservationId: () => 'observation-1',
  nextPlaceRef: () => 'place-1',
  nextResponseId: () => 'response-1',
};

const bodyResponse = JSON.stringify([
  {
    originIndex: 0,
    destinationIndex: 0,
    status: {},
    condition: 'ROUTE_EXISTS',
    distanceMeters: 300,
    duration: '90s',
  },
]);

describe('walking route registry bridge', () => {
  it('resolves candidate coordinates through the public registry and registers the result', async () => {
    const registry = new CandidateObservationRegistry({ now: () => evaluatedAt }, registryIds);
    const registered = registry.registerCandidate({
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
      provider: 'google-places',
      recordRef: 'google-place-1',
      displayName: 'Fixture place',
      status: 'operational',
    });
    const coordinatesByPlaceRef = new Map<string, WalkingCoordinates>([
      [registered.placeRef, candidateCoordinates],
    ]);
    const budget = new RuntimeBudget({
      config: { ...DEFAULT_RUNTIME_BUDGET, maxCostUnits: 4 },
      startedAtMs: 0,
      now: () => 1,
    });
    const transport = createGoogleRouteMatrixTransport({
      apiKey: 'test-key',
      fetcher: () => Promise.resolve(new Response(bodyResponse, { status: 200 })),
    });
    const adapter = createGoogleWalkingRouteAdapter({
      transport,
      budget: createRuntimeRouteBudgetBoundary(budget),
      clock: () => evaluatedAt,
      resolveContext: () => context,
      resolveCandidateCoordinates: (candidateId, value) => {
        const candidate = registry.readCandidate(
          { ownerScopeRef: value.ownerScopeRef, threadId: value.threadId },
          candidateId,
        );
        return candidate === undefined ? undefined : coordinatesByPlaceRef.get(candidate.placeRef);
      },
    });
    const result = await adapter.compute(
      {
        originRef: 'current',
        originCoordinates: currentCoordinates,
        originRevision: 2,
        destinationCandidateId: registered.candidateId,
      },
      context,
      execution,
      { isCancelled: () => false },
    );
    expect(result).toMatchObject({
      status: 'ok',
      data: { destinationCandidateId: registered.candidateId, durationSeconds: 90 },
    });
    if (result.status !== 'ok') return;

    const stored = registry.registerObservation({
      scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      candidateId: registered.candidateId,
      field: 'walking_route',
      value: result.data,
      basis: 'computed',
      sourceUpdatedAt: null,
      freshUntil: '2026-09-10T09:02:00.000Z',
      expiresAt: '2026-09-10T09:05:00.000Z',
      context: {
        ownerScopeRef: context.ownerScopeRef,
        threadId: context.threadId,
        capabilityVersion: 'v1',
        locationRevision: 2,
        originRef: 'current',
        homeStationRef: null,
        minimumStayMinutes: null,
        timeContext: evaluatedAt,
      },
      sources: [
        {
          provider: 'google-routes',
          recordRef: 'compute-route-matrix',
          attribution: null,
          publicUrl: null,
        },
      ],
      retention: {
        retentionDecision: 'allow',
        retentionMode: 'provider_limited',
        sessionExpiresAt: '2026-09-10T10:00:00.000Z',
        freshUntil: '2026-09-10T09:02:00.000Z',
        displayUntil: '2026-09-10T09:02:00.000Z',
        retentionUntil: '2026-09-10T09:05:00.000Z',
        deletionScheduledAt: '2026-09-10T09:05:00.000Z',
        attribution: null,
        restoreMode: 'full',
        policyStatus: 'available',
        displayPolicyStatus: 'available',
      },
    });
    expect(
      registry.readObservation(
        { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
        stored.observationId,
      )?.value,
    ).toEqual(result.data);
  });
});
