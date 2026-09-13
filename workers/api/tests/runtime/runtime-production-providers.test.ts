import type { GetPlaceDetailsInput, HarnessContext, ToolExecutionContext } from '@ima/core';
import { describe, expect, it } from 'vitest';
import { createRuntimeRouteBudgetBoundary } from '../../src/providers/routes/budget';
import {
  context as fixtureContext,
  execution as fixtureExecution,
  makeFixture,
  NOW,
  policy,
} from '../providers/places-details/adapter-fixtures';
import { RuntimeBudget } from '../../src/runtime/budget/runtime-budget';
import { createRuntimeProductionProviderComposition } from '../../src/runtime/composition/runtime-production-providers';

const routeInput = (candidateId: string): GetPlaceDetailsInput => ({
  requests: [{ candidateId, fields: ['walking_route'] }],
  freshness: 'refresh',
});

describe('runtime production provider composition', () => {
  it('connects current-location walking details without requiring a station dataset', async () => {
    const fixture = makeFixture();
    const routeContext: HarnessContext = {
      ...fixtureContext,
      turnId: 'turn-route-production',
      capabilities: {
        ...fixtureContext.capabilities,
        detailFields: ['identity', 'opening_hours', 'price', 'walking_route'],
        walkingRoute: true,
      },
    };
    const execution: ToolExecutionContext = {
      ...fixtureExecution,
      turnId: routeContext.turnId,
    };
    const budget = new RuntimeBudget({ startedAtMs: 0, now: () => 0 });
    const requests: Request[] = [];
    const composition = createRuntimeProductionProviderComposition({
      baseDetails: fixture.adapter,
      registry: fixture.registry,
      clock: () => NOW,
      route: {
        apiKey: 'routes-key',
        budget: createRuntimeRouteBudgetBoundary(budget),
        clock: () => NOW,
        resolveContext: () => routeContext,
        currentOriginRefFor: () => 'current-location',
        observationPolicy: policy,
        fetcher: (input, init) => {
          requests.push(new Request(input, init));
          return Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  originIndex: 0,
                  destinationIndex: 0,
                  status: {},
                  condition: 'ROUTE_EXISTS',
                  distanceMeters: 300,
                  duration: '90s',
                },
              ]),
              { status: 200 },
            ),
          );
        },
      },
    });

    expect(composition.routesEnabled).toBe(true);
    expect(composition.lastTrainEnabled).toBe(false);
    expect(
      composition.capabilitiesFor({
        ...routeContext.capabilities,
        detailFields: ['identity'],
        walkingRoute: false,
      }),
    ).toMatchObject({ walkingRoute: true, detailFields: ['identity', 'walking_route'] });

    const result = await composition.details.read(
      routeInput(fixture.candidateIds[0] ?? ''),
      routeContext,
      execution,
      { isCancelled: () => false },
    );
    expect(result.status).toBe('ok');
    expect(requests).toHaveLength(1);
    if (result.status !== 'ok') return;
    expect(result.data.items[0]?.fields.walking_route).toMatchObject({
      status: 'known',
      observations: [{ value: { durationSeconds: 90, distanceMeters: 300 } }],
    });
    expect(
      fixture.registry.listObservations({
        ownerScopeRef: routeContext.ownerScopeRef,
        threadId: routeContext.threadId,
      }),
    ).toHaveLength(1);
  });

  it('does not assemble paid route calls when the route policy is missing', () => {
    const fixture = makeFixture();
    const composition = createRuntimeProductionProviderComposition({
      baseDetails: fixture.adapter,
      registry: fixture.registry,
      clock: () => NOW,
    });
    expect(composition.routesEnabled).toBe(false);
    expect(
      composition.capabilitiesFor({
        version: 'fixture',
        detailFields: ['identity'],
        walkingRoute: false,
        lastTrain: false,
        supportedScopes: ['thread'],
      }),
    ).toMatchObject({ walkingRoute: false, detailFields: ['identity'] });
  });
});
