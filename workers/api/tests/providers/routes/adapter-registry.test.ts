import { describe, expect, it } from 'vitest';
import {
  CandidateObservationRegistry,
  type HarnessContext,
  type RegistryIdPort,
  type ToolExecutionContext,
} from '@ima/core';
import { RuntimeBudget, DEFAULT_RUNTIME_BUDGET } from '../../../src/runtime/runtime-budget';
import { createGoogleRouteMatrixTransport } from '../../../src/providers/routes/transport';
import {
  createGoogleWalkingRouteAdapter,
  createRuntimeRouteBudgetBoundary,
} from '../../../src/providers/routes/adapter';
import {
  createRegistryRouteWaypointResolver,
  unavailableStationWaypoint,
} from '../../../src/providers/routes/resolver';
import { createRegisteredWalkingRoutePort } from '../../../src/providers/routes/composition';
import { createWalkingRouteRegistration } from '../../../src/providers/routes/registration';

const evaluatedAt = '2026-09-10T09:00:00.000Z';
const currentCoordinates = { lat: 35.6595, lng: 139.7005 };

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
  it('resolves a candidate provider reference through the public registry', async () => {
    const registry = new CandidateObservationRegistry({ now: () => evaluatedAt }, registryIds);
    const registered = registry.registerCandidate({
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
      provider: 'google_places',
      recordRef: 'ChIJfixture',
      displayName: 'Fixture place',
      status: 'operational',
    });
    const bodies: Record<string, unknown>[] = [];
    const budget = new RuntimeBudget({
      config: { ...DEFAULT_RUNTIME_BUDGET, maxCostUnits: 4 },
      startedAtMs: 0,
      now: () => 1,
    });
    const transport = createGoogleRouteMatrixTransport({
      apiKey: 'test-key',
      fetcher: (_input, init) => {
        if (typeof init?.body !== 'string') throw new Error('route request body is not JSON');
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return Promise.resolve(new Response(bodyResponse, { status: 200 }));
      },
    });
    const adapter = createGoogleWalkingRouteAdapter({
      transport,
      budget: createRuntimeRouteBudgetBoundary(budget),
      clock: () => evaluatedAt,
      resolveContext: () => context,
      waypointResolver: createRegistryRouteWaypointResolver({
        registry,
        resolveStationWaypoint: (stationRef) =>
          stationRef === 'station-1'
            ? { ok: true, waypoint: { placeId: 'ChIJstation' } }
            : unavailableStationWaypoint(stationRef, context),
      }),
    });
    const registeredAdapter = createRegisteredWalkingRoutePort({
      port: adapter,
      registration: createWalkingRouteRegistration({
        registry,
        clock: { now: () => evaluatedAt },
        observationPolicy: () => ({
          freshUntil: '2026-09-10T09:02:00.000Z',
          expiresAt: '2026-09-10T09:05:00.000Z',
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
        }),
      }),
    });
    const result = await registeredAdapter.compute(
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
    expect(bodies[0]).toMatchObject({
      destinations: [{ waypoint: { placeId: 'ChIJfixture' } }],
    });
    expect(JSON.stringify(result.data)).not.toContain('ChIJfixture');
    const observations = registry.listObservations({
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      candidateId: registered.candidateId,
      field: 'walking_route',
      value: result.data,
      basis: 'computed',
      context: { timeContext: 'now' },
      sources: [{ provider: 'google_routes', recordRef: 'compute-route-matrix' }],
      retention: { retentionDecision: 'allow', retentionMode: 'provider_limited' },
    });
    const reuse = registry.evaluateObservationReuse({
      scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      candidateId: registered.candidateId,
      field: 'walking_route',
      context: {
        ownerScopeRef: context.ownerScopeRef,
        threadId: context.threadId,
        capabilityVersion: context.capabilities.version,
        locationRevision: result.data.originRevision,
        originRef: result.data.originRef,
        homeStationRef: context.preferences.homeStationRef,
        minimumStayMinutes: context.preferences.minimumStayMinutes,
        timeContext: 'now',
      },
    });
    expect(reuse.status).toBe('reusable');
    if (reuse.status === 'reusable') expect(reuse.observation.value).toEqual(result.data);

    const withheld = createWalkingRouteRegistration({
      registry,
      clock: { now: () => evaluatedAt },
      observationPolicy: () => undefined,
    });
    expect(withheld.register(registered.candidateId, result.data, context)).toBeUndefined();
    expect(
      registry.listObservations({
        ownerScopeRef: context.ownerScopeRef,
        threadId: context.threadId,
      }),
    ).toHaveLength(1);

    const stationResult = await adapter.computeDirected(
      {
        legs: [
          {
            kind: 'candidate_to_station',
            originCandidateId: registered.candidateId,
            originRef: 'candidate-1-place',
            destinationStationRef: 'station-1',
          },
        ],
      },
      context,
      execution,
      { isCancelled: () => false },
    );
    expect(stationResult).toMatchObject({ status: 'ok' });
    expect(bodies[1]).toMatchObject({
      origins: [{ waypoint: { placeId: 'ChIJfixture' } }],
      destinations: [{ waypoint: { placeId: 'ChIJstation' } }],
    });
  });

  it('does not register a station result when cancellation is observed after the provider', async () => {
    let registrations = 0;
    let cancelled = false;
    const registeredAdapter = createRegisteredWalkingRoutePort({
      port: {
        compute: () =>
          Promise.resolve({
            status: 'error' as const,
            error: {
              code: 'MISSING_EVIDENCE' as const,
              path: 'walking_route',
              retryable: false,
              retryAfterMs: null,
              message: 'unused current route fixture',
              missingFields: [],
            },
          }),
        computeDirected: () => {
          cancelled = true;
          return Promise.resolve({
            status: 'ok' as const,
            data: [
              {
                kind: 'route' as const,
                leg: 'candidate_to_station' as const,
                route: {
                  originCandidateId: 'candidate-1',
                  originRef: 'candidate-1-place',
                  destinationStationRef: 'station-1',
                  evaluatedAt,
                  durationSeconds: 90,
                  distanceMeters: 300,
                  warnings: [],
                },
              },
            ],
            warnings: [],
          });
        },
      },
      registration: {
        register: () => {
          registrations += 1;
          return undefined;
        },
      },
    });

    const result = await registeredAdapter.computeDirected(
      {
        legs: [
          {
            kind: 'candidate_to_station',
            originCandidateId: 'candidate-1',
            originRef: 'candidate-1-place',
            destinationStationRef: 'station-1',
          },
        ],
      },
      context,
      execution,
      { isCancelled: () => cancelled },
    );

    expect(result).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
    expect(registrations).toBe(0);
  });

  it('keeps a valid route when another candidate cannot resolve a provider waypoint', async () => {
    let candidateSequence = 0;
    let placeSequence = 0;
    const ids: RegistryIdPort = {
      ...registryIds,
      nextCandidateId: () => `candidate-${++candidateSequence}`,
      nextPlaceRef: () => `place-${++placeSequence}`,
    };
    const registry = new CandidateObservationRegistry({ now: () => evaluatedAt }, ids);
    const valid = registry.registerCandidate({
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
      provider: 'google_places',
      recordRef: 'ChIJvalid',
      displayName: 'Valid fixture place',
      status: 'operational',
    });
    const excluded = registry.registerCandidate({
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
      provider: 'google_places',
      recordRef: 'ChIJexcluded',
      displayName: 'Excluded fixture place',
      status: 'operational',
    });
    registry.excludeCandidate(
      { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      excluded.candidateId,
    );
    const bodies: Record<string, unknown>[] = [];
    const budget = new RuntimeBudget({
      config: { ...DEFAULT_RUNTIME_BUDGET, maxCostUnits: 4 },
      startedAtMs: 0,
      now: () => 1,
    });
    const transport = createGoogleRouteMatrixTransport({
      apiKey: 'test-key',
      fetcher: (_input, init) => {
        if (typeof init?.body !== 'string') throw new Error('route request body is not JSON');
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return Promise.resolve(new Response(bodyResponse, { status: 200 }));
      },
    });
    const adapter = createGoogleWalkingRouteAdapter({
      transport,
      budget: createRuntimeRouteBudgetBoundary(budget),
      clock: () => evaluatedAt,
      resolveContext: () => context,
      waypointResolver: createRegistryRouteWaypointResolver({
        registry,
        resolveStationWaypoint: unavailableStationWaypoint,
      }),
    });

    const result = await adapter.computeDirected(
      {
        legs: [
          {
            kind: 'current_to_candidate',
            originRef: 'current',
            originCoordinates: currentCoordinates,
            originRevision: 2,
            destinationCandidateId: excluded.candidateId,
          },
          {
            kind: 'current_to_candidate',
            originRef: 'current-valid',
            originCoordinates: currentCoordinates,
            originRevision: 2,
            destinationCandidateId: valid.candidateId,
          },
        ],
      },
      context,
      execution,
      { isCancelled: () => false },
    );

    expect(result.status).toBe('partial');
    if (result.status === 'partial') {
      const validResult = result.data.find(
        (item): item is Extract<typeof item, { kind: 'route' }> => item.kind === 'route',
      );
      expect(validResult).toMatchObject({
        route: { destinationCandidateId: valid.candidateId },
      });
      const excludedResult = result.data.find(
        (item) => item.kind === 'element_error' && item.destinationRef === excluded.candidateId,
      );
      expect(excludedResult).toMatchObject({ reason: 'EXCLUDED_CANDIDATE' });
      expect(result.warnings.some((warning) => warning.code === 'EXCLUDED_CANDIDATE')).toBe(true);
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      destinations: [{ waypoint: { placeId: 'ChIJvalid' } }],
    });
  });

  it('rejects provider records that cannot be used as a Google waypoint', () => {
    let candidateSequence = 0;
    let placeSequence = 0;
    const ids: RegistryIdPort = {
      ...registryIds,
      nextCandidateId: () => `candidate-${++candidateSequence}`,
      nextPlaceRef: () => `place-${++placeSequence}`,
    };
    const registry = new CandidateObservationRegistry({ now: () => evaluatedAt }, ids);
    const unsupported = registry.registerCandidate({
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
      provider: 'other_provider',
      recordRef: 'provider-record',
      displayName: 'Unsupported provider',
      status: 'operational',
    });
    const malformed = registry.registerCandidate({
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
      provider: 'google_places',
      recordRef: 'not a place id',
      displayName: 'Malformed provider reference',
      status: 'operational',
    });
    const lookup = createRegistryRouteWaypointResolver({
      registry,
      resolveStationWaypoint: unavailableStationWaypoint,
    });
    expect(lookup.resolveCandidateWaypoint(unsupported.candidateId, context)).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_FIELD' },
    });
    expect(lookup.resolveCandidateWaypoint(malformed.candidateId, context)).toMatchObject({
      ok: false,
      error: { code: 'MISSING_EVIDENCE' },
    });
    expect(lookup.resolveStationWaypoint('station-unknown', context)).toMatchObject({
      ok: false,
      error: { code: 'MISSING_EVIDENCE' },
    });
  });
});
