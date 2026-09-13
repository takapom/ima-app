import { describe, expect, it } from 'vitest';
import { unavailableStationWaypoint } from '../../src/providers/routes/resolver';
import type { RuntimeJourneyDataset } from '../../src/providers/last-train/port';
import {
  createRuntimeProductionConnectionOptions,
  type RuntimeProductionOverrides,
} from '../../src/runtime/composition/runtime-production-factory';
import {
  FIXTURE_OPERATIONAL_ENV,
  NOW,
  buildRequest,
  readOnlyCommit as commit,
} from './runtime-production-factory-fixtures';
import { modelFor } from '../support/runtime-model-fixture';

const baseEnvironment = {
  ...FIXTURE_OPERATIONAL_ENV,
  OPENAI_API_KEY: 'openai-test-key',
};

const dataset = (readRevision: () => Promise<number | null>): RuntimeJourneyDataset => ({
  read: () => Promise.reject(new Error('journey read should not run in this test')),
  readRevision,
});

const build = (overrides: RuntimeProductionOverrides) =>
  createRuntimeProductionConnectionOptions({
    env: baseEnvironment,
    commit,
    overrides: {
      modelForTurn: modelFor('search', { calls: 0, requests: [] }),
      placesEnabled: false,
      fetcher: () => Promise.reject(new Error('route fetch should not run in this test')),
      clock: () => NOW,
      monotonicNow: () => 0,
      epochNow: () => 1_000,
      ...overrides,
    },
  });

describe('production JourneyDataset binding gate', () => {
  it('does not probe the dataset when route or station dependencies are absent', async () => {
    let revisionReads = 0;
    const options = build({
      routesEnabled: true,
      googleRoutesApiKey: 'routes-test-key',
      journeyDataset: dataset(() => {
        revisionReads += 1;
        return Promise.resolve(7);
      }),
    });
    if (options === undefined) throw new Error('production factory should be configured');

    const composition = await options.buildTurn(buildRequest);
    expect(revisionReads).toBe(0);
    expect(composition.turn.context.capabilities.lastTrain).toBe(false);
    composition.dispose();
  });

  it('probes once when all dependencies are ready and keeps the origin stable for assembly', async () => {
    let originCalls = 0;
    let revisionReads = 0;
    const options = build({
      routesEnabled: true,
      googleRoutesApiKey: 'routes-test-key',
      routeObservationPolicy: () => undefined,
      currentOriginRefFor: () => {
        originCalls += 1;
        return 'current-location';
      },
      journeyDataset: dataset(() => {
        revisionReads += 1;
        return Promise.resolve(7);
      }),
      buildServiceDateContext: () => undefined,
      lastTrainObservationPolicy: () => undefined,
      fromStationRefFor: () => 'station-from',
      resolveStationWaypoint: unavailableStationWaypoint,
    });
    if (options === undefined) throw new Error('production factory should be configured');

    const composition = await options.buildTurn(buildRequest);
    expect(revisionReads).toBe(1);
    expect(originCalls).toBe(1);
    expect(composition.turn.context.capabilities.lastTrain).toBe(true);
    composition.dispose();
  });

  it('treats an origin resolver exception as a disabled route without probing the dataset', async () => {
    let revisionReads = 0;
    const options = build({
      routesEnabled: true,
      googleRoutesApiKey: 'routes-test-key',
      routeObservationPolicy: () => undefined,
      currentOriginRefFor: () => {
        throw new Error('origin resolver failed');
      },
      journeyDataset: dataset(() => {
        revisionReads += 1;
        return Promise.resolve(7);
      }),
      buildServiceDateContext: () => undefined,
      lastTrainObservationPolicy: () => undefined,
      fromStationRefFor: () => 'station-from',
      resolveStationWaypoint: unavailableStationWaypoint,
    });
    if (options === undefined) throw new Error('production factory should be configured');

    const composition = await options.buildTurn(buildRequest);
    expect(revisionReads).toBe(0);
    expect(composition.turn.context.capabilities.walkingRoute).toBe(false);
    expect(composition.turn.context.capabilities.lastTrain).toBe(false);
    composition.dispose();
  });
});
