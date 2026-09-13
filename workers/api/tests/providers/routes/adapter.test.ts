import { describe, expect, it } from 'vitest';
import type { HarnessContext, ToolExecutionContext } from '@ima/core';
import {
  DEFAULT_RUNTIME_BUDGET,
  RuntimeBudget,
  type RuntimeBudgetConfig,
} from '../../../src/runtime/budget/runtime-budget';
import {
  createGoogleWalkingRouteAdapter,
  createRuntimeRouteBudgetBoundary,
  preReservedRouteBudget,
  type RouteReadCost,
} from '../../../src/providers/routes/adapter';
import { createGoogleRouteMatrixTransport } from '../../../src/providers/routes/transport';
import type { RouteWaypointLookup } from '../../../src/providers/routes/resolver';

const evaluatedAt = '2026-09-10T09:00:00.000Z';
const currentCoordinates = { lat: 35.6595, lng: 139.7005 };
const candidateCoordinates = { lat: 35.658, lng: 139.7016 };
const stationCoordinates = { lat: 35.6467, lng: 139.71 };

const context: HarnessContext = {
  threadId: 'thread-1',
  turnId: 'turn-1',
  revision: 2,
  serverNow: evaluatedAt,
  ownerScopeRef: 'owner-1',
  location: {
    status: 'available',
    coordinates: currentCoordinates,
    accuracyMeters: 50,
    precise: true,
    capturedAt: '2026-09-10T08:59:00.000Z',
    revision: 2,
  },
  preferences: {
    homeStationRef: 'station-1',
    maxWalkMinutes: 15,
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
    detailFields: ['identity', 'walking_route'],
    walkingRoute: true,
    lastTrain: false,
    supportedScopes: ['thread'],
  },
};

const execution: ToolExecutionContext = {
  callId: 'call-1',
  operation: 'walking_route',
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
};

const currentLeg = (candidateId: string) => ({
  kind: 'current_to_candidate' as const,
  originRef: 'current',
  originCoordinates: currentCoordinates,
  originRevision: 2,
  destinationCandidateId: candidateId,
});

const stationLeg = {
  kind: 'candidate_to_station' as const,
  originCandidateId: 'candidate-1',
  originRef: 'candidate-1-place',
  destinationStationRef: 'station-1',
};

const stationLegFor = (candidateId: string, originRef: string, stationRef: string) => ({
  kind: 'candidate_to_station' as const,
  originCandidateId: candidateId,
  originRef,
  destinationStationRef: stationRef,
});

const budgetConfig = (overrides: Partial<RuntimeBudgetConfig> = {}): RuntimeBudgetConfig => ({
  ...DEFAULT_RUNTIME_BUDGET,
  maxCostUnits: 20,
  maxRouteElements: 8,
  ...overrides,
});

type Fixture = {
  readonly budget: RuntimeBudget;
  readonly bodies: Record<string, unknown>[];
  readonly adapter: ReturnType<typeof createGoogleWalkingRouteAdapter>;
};

const makeFixture = (
  responseFor: (body: Record<string, unknown>) => unknown,
  resolveContext: () => HarnessContext = () => context,
  resolveStationWaypoint: RouteWaypointLookup['resolveStationWaypoint'] = (stationRef) => ({
    ok: true,
    waypoint: {
      coordinates: stationRef === 'station-1' ? stationCoordinates : { lat: 35.645, lng: 139.711 },
    },
  }),
): Fixture => {
  const bodies: Record<string, unknown>[] = [];
  const budget = new RuntimeBudget({
    config: budgetConfig(),
    startedAtMs: 0,
    now: () => 1,
  });
  const fetcher: typeof fetch = (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('fixture request body is not JSON text');
    const parsed = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(parsed);
    return Promise.resolve(new Response(JSON.stringify(responseFor(parsed)), { status: 200 }));
  };
  const transport = createGoogleRouteMatrixTransport({ apiKey: 'test-key', fetcher });
  return {
    budget,
    bodies,
    adapter: createGoogleWalkingRouteAdapter({
      transport,
      budget: createRuntimeRouteBudgetBoundary(budget),
      clock: () => evaluatedAt,
      resolveContext,
      waypointResolver: {
        resolveCandidateWaypoint: (candidateId) => ({
          ok: true,
          waypoint: {
            coordinates:
              candidateId === 'candidate-1' ? candidateCoordinates : { lat: 35.657, lng: 139.702 },
          },
        }),
        resolveStationWaypoint,
      },
    }),
  };
};

const routeElements = (body: Record<string, unknown>, malformed = false): unknown[] => {
  const origins = body.origins as readonly unknown[];
  const destinations = body.destinations as readonly unknown[];
  return origins.flatMap((_origin, originIndex) =>
    destinations.map((_destination, destinationIndex) => ({
      originIndex,
      destinationIndex,
      status: {},
      condition: 'ROUTE_EXISTS',
      distanceMeters: 300 + destinationIndex,
      duration: malformed && destinationIndex === 1 ? 'bad' : `${90 + destinationIndex}s`,
    })),
  );
};

describe('Google walking route Core adapter', () => {
  it('reserves both directed matrix groups before HTTP and preserves their direction', async () => {
    let observedAtFetch: ReturnType<RuntimeBudget['snapshot']> | undefined;
    const fixture = makeFixture((body) => {
      observedAtFetch = fixture.budget.snapshot();
      return routeElements(body);
    });
    const result = await fixture.adapter.computeDirected(
      { legs: [currentLeg('candidate-1'), stationLeg] },
      context,
      execution,
      { isCancelled: () => false },
    );

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.map((item) => item.kind)).toEqual(['route', 'route']);
      expect(result.data[0]).toMatchObject({
        leg: 'current_to_candidate',
        route: { destinationCandidateId: 'candidate-1', originRevision: 2, durationSeconds: 90 },
      });
      expect(result.data[1]).toMatchObject({
        leg: 'candidate_to_station',
        route: { originCandidateId: 'candidate-1', destinationStationRef: 'station-1' },
      });
    }
    expect(fixture.bodies).toHaveLength(2);
    expect(fixture.bodies[0]).toMatchObject({ travelMode: 'WALK' });
    expect(fixture.bodies[0]).not.toHaveProperty('departureTime');
    expect(fixture.budget.snapshot()).toMatchObject({
      readCalls: 1,
      providerHttpRequests: 2,
      routeElements: 2,
      costUnits: 4,
      activeReads: 0,
    });
    expect(observedAtFetch).toMatchObject({ readCalls: 1, providerHttpRequests: 2 });
    const firstBody = fixture.bodies[0];
    const secondBody = fixture.bodies[1];
    expect(firstBody?.origins).toEqual([
      {
        waypoint: {
          location: {
            latLng: { latitude: currentCoordinates.lat, longitude: currentCoordinates.lng },
          },
        },
      },
    ]);
    expect(secondBody?.origins).toEqual([
      {
        waypoint: {
          location: {
            latLng: { latitude: candidateCoordinates.lat, longitude: candidateCoordinates.lng },
          },
        },
      },
    ]);
  });

  it('does not reserve or call the provider for stale, old, inaccurate, or moved location', async () => {
    const cases: readonly HarnessContext['location'][] = [
      { ...context.location, revision: 3 },
      { ...context.location, capturedAt: '2026-09-10T08:57:59.999Z' },
      { ...context.location, accuracyMeters: 101 },
      { ...context.location, coordinates: { lat: 35.661, lng: 139.7005 } },
    ];
    for (const location of cases) {
      const fixture = makeFixture(
        () => [],
        () => ({ ...context, location }),
      );
      const result = await fixture.adapter.computeDirected(
        { legs: [currentLeg('candidate-1')] },
        { ...context, location },
        execution,
        { isCancelled: () => false },
      );
      expect(result.status).toBe('error');
      expect(fixture.bodies).toHaveLength(0);
      expect(fixture.budget.snapshot()).toMatchObject({ readCalls: 0, providerHttpRequests: 0 });
    }
  });

  it('keeps a current route when every station waypoint is unavailable', async () => {
    const fixture = makeFixture(
      (body) => routeElements(body),
      () => context,
      () => ({
        ok: false,
        error: {
          code: 'MISSING_EVIDENCE',
          path: 'destinationStationRef',
          retryable: false,
          retryAfterMs: null,
          message: 'station waypoint is unavailable',
          missingFields: ['destinationStationRef'],
        },
      }),
    );
    const result = await fixture.adapter.computeDirected(
      { legs: [currentLeg('candidate-1'), stationLeg] },
      context,
      execution,
      { isCancelled: () => false },
    );

    expect(result.status).toBe('partial');
    if (result.status === 'partial') {
      expect(result.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'route', leg: 'current_to_candidate' }),
          expect.objectContaining({
            kind: 'element_error',
            leg: 'candidate_to_station',
            reason: 'MISSING_EVIDENCE',
          }),
        ]),
      );
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'MISSING_EVIDENCE' })]),
      );
    }
    expect(fixture.bodies).toHaveLength(1);
    expect(fixture.budget.snapshot()).toMatchObject({
      providerHttpRequests: 1,
      routeElements: 1,
    });
  });

  it('keeps valid elements when another indexed element is malformed', async () => {
    const fixture = makeFixture((body) => routeElements(body, true));
    const result = await fixture.adapter.computeDirected(
      {
        legs: [currentLeg('candidate-1'), currentLeg('candidate-2')],
      },
      context,
      execution,
      { isCancelled: () => false },
    );
    expect(result.status).toBe('partial');
    if (result.status === 'partial') {
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toMatchObject({ kind: 'route', leg: 'current_to_candidate' });
      expect(result.data[1]).toMatchObject({ kind: 'element_error', leg: 'current_to_candidate' });
      expect(result.warnings[0]).toMatchObject({ code: 'SCHEMA_MISMATCH' });
    }
  });

  it('does not expose unrequested cross pairs in a sparse two-origin matrix', async () => {
    const fixture = makeFixture((body) => routeElements(body));
    const result = await fixture.adapter.computeDirected(
      {
        legs: [
          stationLegFor('candidate-1', 'candidate-1-place', 'station-1'),
          stationLegFor('candidate-2', 'candidate-2-place', 'station-2'),
        ],
      },
      context,
      execution,
      { isCancelled: () => false },
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data).toHaveLength(2);
      expect(result.data.every((item) => item.leg === 'candidate_to_station')).toBe(true);
    }
    expect(fixture.budget.snapshot()).toMatchObject({ routeElements: 4, providerHttpRequests: 1 });
  });

  it('keeps a successful direction when the other matrix group fails upstream', async () => {
    const bodies: Record<string, unknown>[] = [];
    const budget = new RuntimeBudget({ config: budgetConfig(), startedAtMs: 0, now: () => 1 });
    const transport = createGoogleRouteMatrixTransport({
      apiKey: 'test-key',
      fetcher: (_input, init) => {
        if (typeof init?.body !== 'string')
          throw new Error('fixture request body is not JSON text');
        const body = JSON.parse(init.body) as Record<string, unknown>;
        bodies.push(body);
        const origins = body.origins as readonly Record<string, unknown>[];
        if (origins.length > 0 && origins[0]?.waypoint !== undefined) {
          const location = origins[0].waypoint as Record<string, unknown>;
          const nested = location.location as Record<string, unknown>;
          const latLng = nested.latLng as Record<string, unknown>;
          if (latLng.latitude === candidateCoordinates.lat) {
            return Promise.resolve(new Response('provider unavailable', { status: 503 }));
          }
        }
        return Promise.resolve(new Response(JSON.stringify(routeElements(body)), { status: 200 }));
      },
    });
    const adapter = createGoogleWalkingRouteAdapter({
      transport,
      budget: createRuntimeRouteBudgetBoundary(budget),
      clock: () => evaluatedAt,
      resolveContext: () => context,
      waypointResolver: {
        resolveCandidateWaypoint: () => ({
          ok: true,
          waypoint: { coordinates: candidateCoordinates },
        }),
        resolveStationWaypoint: () => ({
          ok: true,
          waypoint: { coordinates: stationCoordinates },
        }),
      },
    });
    const result = await adapter.computeDirected(
      { legs: [currentLeg('candidate-1'), stationLeg] },
      context,
      execution,
      { isCancelled: () => false },
    );
    expect(result.status).toBe('partial');
    if (result.status === 'partial') {
      expect(result.data.some((item) => item.kind === 'route')).toBe(true);
      expect(result.data.some((item) => item.kind === 'element_error')).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'UPSTREAM_UNAVAILABLE' })]),
      );
    }
    expect(bodies).toHaveLength(2);
  });

  it('accepts an exact pre-reserved lease without incrementing the budget twice', async () => {
    const fixture = makeFixture((body) => routeElements(body));
    const cost: RouteReadCost = {
      costUnits: 2,
      providerHttpRequests: 1,
      routeElements: 1,
    };
    const reservation = fixture.budget.reserveRoute(cost);
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error('route reservation setup failed');
    const preReserved = createGoogleWalkingRouteAdapter({
      transport: createGoogleRouteMatrixTransport({
        apiKey: 'test-key',
        fetcher: (_input, init) => {
          if (typeof init?.body !== 'string')
            throw new Error('fixture request body is not JSON text');
          const parsed = JSON.parse(init.body) as Record<string, unknown>;
          fixture.bodies.push(parsed);
          return Promise.resolve(
            new Response(JSON.stringify(routeElements(parsed)), { status: 200 }),
          );
        },
      }),
      budget: preReservedRouteBudget(reservation.value),
      clock: () => evaluatedAt,
      resolveContext: () => context,
      waypointResolver: {
        resolveCandidateWaypoint: () => ({
          ok: true,
          waypoint: { coordinates: candidateCoordinates },
        }),
        resolveStationWaypoint: () => ({
          ok: true,
          waypoint: { coordinates: stationCoordinates },
        }),
      },
    });
    const result = await preReserved.computeDirected(
      { legs: [currentLeg('candidate-1')] },
      context,
      execution,
      { isCancelled: () => false },
    );
    expect(result.status).toBe('ok');
    expect(fixture.budget.snapshot()).toMatchObject({ readCalls: 1, providerHttpRequests: 1 });
    const repeated = await preReserved.computeDirected(
      { legs: [currentLeg('candidate-1')] },
      context,
      execution,
      { isCancelled: () => false },
    );
    expect(repeated).toMatchObject({ status: 'error', error: { code: 'BUDGET_EXCEEDED' } });
    expect(fixture.bodies).toHaveLength(1);
    reservation.value.release();
  });
  it('honors cancellation before admission and keeps provider calls at zero', async () => {
    const fixture = makeFixture(() => []);
    const result = await fixture.adapter.computeDirected(
      { legs: [currentLeg('candidate-1')] },
      context,
      execution,
      { isCancelled: () => true },
    );
    expect(result).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
    expect(fixture.budget.snapshot()).toMatchObject({ readCalls: 0, providerHttpRequests: 0 });
    expect(fixture.bodies).toHaveLength(0);
  });

  it('does not consume a route lease after cancellation, completion, or final reserve starts', () => {
    const expectedCodes = {
      cancelled: 'CANCELLED',
      completed: 'COMMITTED',
      'final-reserve': 'FINAL_RESERVE',
    } as const;
    for (const state of ['cancelled', 'completed', 'final-reserve'] as const) {
      let now = 1;
      const budget = new RuntimeBudget({
        config: budgetConfig(),
        startedAtMs: 0,
        now: () => now,
      });
      const reservation = budget.reserveRoute({
        costUnits: 2,
        providerHttpRequests: 1,
        routeElements: 1,
      });
      expect(reservation.ok).toBe(true);
      if (!reservation.ok) continue;
      if (state === 'cancelled') budget.cancel();
      if (state === 'completed') budget.markCommitted();
      if (state === 'final-reserve') now = 10_000;
      expect(reservation.value.consume()).toMatchObject({
        ok: false,
        denial: { code: expectedCodes[state] },
      });
      reservation.value.release();
    }
  });
});
