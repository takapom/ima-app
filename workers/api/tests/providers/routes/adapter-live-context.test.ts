import { describe, expect, it } from 'vitest';
import type { HarnessContext, ToolExecutionContext } from '@ima/core';
import { DEFAULT_RUNTIME_BUDGET, RuntimeBudget } from '../../../src/runtime/runtime-budget';
import {
  createGoogleWalkingRouteAdapter,
  createRuntimeRouteBudgetBoundary,
} from '../../../src/providers/routes/adapter';
import { createGoogleRouteMatrixTransport } from '../../../src/providers/routes/transport';

const firstAt = '2026-09-10T09:00:00.000Z';
const secondAt = '2026-09-10T09:01:00.000Z';
const current = { lat: 35.6595, lng: 139.7005 };
const candidate = { lat: 35.658, lng: 139.7016 };

const context: HarnessContext = {
  threadId: 'thread-live',
  turnId: 'turn-live',
  revision: 2,
  serverNow: firstAt,
  ownerScopeRef: 'owner-live',
  location: {
    status: 'available',
    coordinates: current,
    accuracyMeters: 40,
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
  callId: 'call-live',
  operation: 'walking_route',
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
};

const input = {
  legs: [
    {
      kind: 'current_to_candidate' as const,
      originRef: 'current',
      originCoordinates: current,
      originRevision: 2,
      destinationCandidateId: 'candidate-1',
      destinationCoordinates: candidate,
    },
  ],
};

const response = JSON.stringify([
  {
    originIndex: 0,
    destinationIndex: 0,
    status: {},
    condition: 'ROUTE_EXISTS',
    distanceMeters: 300,
    duration: '90s',
  },
]);

const makeAdapter = (resolveContext: () => HarnessContext, clock: () => string) => {
  const bodies: Record<string, unknown>[] = [];
  const budget = new RuntimeBudget({
    config: { ...DEFAULT_RUNTIME_BUDGET, maxCostUnits: 4 },
    startedAtMs: 0,
    now: () => 1,
  });
  const transport = createGoogleRouteMatrixTransport({
    apiKey: 'test-key',
    fetcher: (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('fixture request body is not JSON text');
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve(new Response(response, { status: 200 }));
    },
  });
  return {
    budget,
    bodies,
    adapter: createGoogleWalkingRouteAdapter({
      transport,
      budget: createRuntimeRouteBudgetBoundary(budget),
      clock,
      resolveContext,
      resolveCandidateCoordinates: () => candidate,
    }),
  };
};

describe('walking route live context boundary', () => {
  it('discards a provider result when location revision changes while the request is in flight', async () => {
    let calls = 0;
    const fixture = makeAdapter(
      () => {
        calls += 1;
        return calls === 1
          ? context
          : { ...context, location: { ...context.location, revision: 3 } };
      },
      () => firstAt,
    );
    const result = await fixture.adapter.computeDirected(input, context, execution, {
      isCancelled: () => false,
    });
    expect(result).toMatchObject({ status: 'error', error: { code: 'STALE_TURN' } });
    expect(fixture.budget.snapshot()).toMatchObject({ readCalls: 1, activeReads: 0 });
  });

  it('measures post-fetch movement from the coordinates sent to the provider', async () => {
    const inputOrigin = current;
    const sentOrigin = { lat: current.lat - 0.0008, lng: current.lng };
    const fetchedLocation = { lat: current.lat + 0.0008, lng: current.lng };
    const startContext: HarnessContext = {
      ...context,
      location: { ...context.location, coordinates: sentOrigin },
    };
    const afterContext: HarnessContext = {
      ...context,
      location: { ...context.location, coordinates: fetchedLocation },
    };
    let contextCalls = 0;
    const fixture = makeAdapter(
      () => {
        contextCalls += 1;
        return contextCalls === 1 ? startContext : afterContext;
      },
      () => firstAt,
    );
    const result = await fixture.adapter.computeDirected(
      {
        legs: [
          {
            kind: 'current_to_candidate',
            originRef: 'current',
            originCoordinates: inputOrigin,
            originRevision: 2,
            destinationCandidateId: 'candidate-1',
            destinationCoordinates: candidate,
          },
        ],
      },
      startContext,
      execution,
      { isCancelled: () => false },
    );
    expect(result).toMatchObject({ status: 'error', error: { code: 'LOCATION_IMPRECISE' } });
    expect(fixture.bodies[0]).toMatchObject({
      origins: [
        {
          waypoint: {
            location: {
              latLng: { latitude: sentOrigin.lat, longitude: sentOrigin.lng },
            },
          },
        },
      ],
    });
    expect(fixture.budget.snapshot()).toMatchObject({ readCalls: 1, activeReads: 0 });
  });

  it('uses the completion clock for route observation evaluation', async () => {
    let clockCalls = 0;
    const fixture = makeAdapter(
      () => context,
      () => {
        clockCalls += 1;
        return clockCalls === 1 ? firstAt : secondAt;
      },
    );
    const result = await fixture.adapter.computeDirected(input, context, execution, {
      isCancelled: () => false,
    });
    expect(result).toMatchObject({ status: 'ok' });
    if (result.status === 'ok')
      expect(result.data[0]).toMatchObject({ route: { evaluatedAt: secondAt } });
  });
});
