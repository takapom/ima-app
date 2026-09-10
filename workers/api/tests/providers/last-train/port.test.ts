import * as v from 'valibot';
import {
  JOURNEY_DATASET_SCHEMA_VERSION,
  JourneyDatasetEnvelopeSchema,
  type JourneyDatasetEnvelope,
} from '../../../src/providers/last-train/types';
import {
  createLastTrainJourneyPort,
  type JourneyDatasetReadPort,
  type LastTrainRoutePorts,
} from '../../../src/providers/last-train/port';
import type { JourneyReadResult } from '../../../src/providers/last-train/reader';
import type { JourneyDatasetReader } from '../../../src/providers/last-train/store';
import type {
  HarnessContext,
  JourneyServiceDateContext,
  JourneyRecord,
  LastTrainJourneyInput,
  ToolExecutionContext,
} from '@ima/core';
import { describe, expect, it } from 'vitest';

const now = '2026-09-10T12:00:00Z';

const makeJourney = (journeyRef: string): JourneyRecord => ({
  journeyRef,
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
  serviceDate: '2026-09-10',
  servicePattern: { weekdays: ['thursday'], holidayPolicy: 'allowed' },
  lastDepartureAt: '2026-09-10T23:50:00+09:00',
  arrivesHomeAt: '2026-09-11T00:30:00+09:00',
  transfers: [],
  validFrom: '2026-09-01',
  validThrough: '2026-09-30',
  verifiedAt: '2026-09-05T12:00:00Z',
  source: {
    provider: 'fixture',
    recordRef: 'm14-port-fixture',
    attribution: 'test only',
    publicUrl: null,
  },
});

const makeDataset = (journeys: readonly JourneyRecord[]): JourneyDatasetEnvelope =>
  v.parse(JourneyDatasetEnvelopeSchema, {
    schemaVersion: JOURNEY_DATASET_SCHEMA_VERSION,
    revision: 1,
    importedAt: now,
    sourceRevision: null,
    records: journeys,
  });

const context: HarnessContext = {
  threadId: 'thread-last-train',
  turnId: 'turn-last-train',
  revision: 3,
  serverNow: now,
  ownerScopeRef: 'owner-last-train',
  location: {
    status: 'available',
    coordinates: { lat: 35.6595, lng: 139.7005 },
    accuracyMeters: 40,
    precise: true,
    capturedAt: '2026-09-10T11:59:00Z',
    revision: 3,
  },
  preferences: {
    homeStationRef: 'station-b',
    maxWalkMinutes: 15,
    minimumStayMinutes: 20,
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
    detailFields: ['last_train'],
    walkingRoute: true,
    lastTrain: true,
    supportedScopes: ['thread'],
  },
};

const input: LastTrainJourneyInput = {
  candidateId: 'candidate-1',
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
  departure: 'now',
  minimumStayMinutes: 20,
};

const execution: ToolExecutionContext = {
  callId: 'call-last-train',
  operation: 'last_train',
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
};

const routePorts = (calls: {
  current: number;
  station: number;
  stationDestinations: string[];
  routeExecutions?: ToolExecutionContext[];
}): LastTrainRoutePorts => ({
  currentToCandidate: {
    compute: (routeInput, _context, routeExecution) => {
      calls.current += 1;
      calls.routeExecutions?.push(routeExecution);
      return Promise.resolve({
        status: 'ok' as const,
        data: {
          originRef: routeInput.originRef,
          destinationCandidateId: routeInput.destinationCandidateId,
          originRevision: routeInput.originRevision,
          evaluatedAt: now,
          durationSeconds: 600,
          distanceMeters: 900,
          warnings: [],
        },
        warnings: [],
      });
    },
  },
  candidateToStation: {
    computeDirected: (routeInput, _context, routeExecution) => {
      calls.station += 1;
      calls.routeExecutions?.push(routeExecution);
      const leg = routeInput.legs[0];
      if (leg === undefined || leg.kind !== 'candidate_to_station') {
        return Promise.resolve({
          status: 'error' as const,
          error: {
            code: 'INVALID_ARGUMENT' as const,
            path: 'legs',
            retryable: false,
            retryAfterMs: null,
            message: 'station leg missing',
            missingFields: ['legs'],
          },
        });
      }
      calls.stationDestinations.push(leg.destinationStationRef);
      return Promise.resolve({
        status: 'ok' as const,
        data: [
          {
            kind: 'route' as const,
            leg: 'candidate_to_station' as const,
            route: {
              originCandidateId: leg.originCandidateId,
              originRef: leg.originRef,
              destinationStationRef: leg.destinationStationRef,
              evaluatedAt: now,
              durationSeconds: 180,
              distanceMeters: 200,
              warnings: [],
            },
          },
        ],
        warnings: [],
      });
    },
  },
});

const serviceDateContext = (
  _context: HarnessContext,
  request: LastTrainJourneyInput,
  clock: string,
) => ({
  serviceDate: '2026-09-10',
  weekday: 'thursday' as const,
  isHoliday: false,
  now: clock,
  fromStationRef: request.fromStationRef,
  homeStationRef: request.homeStationRef,
});

const readerFor = (datasets: readonly unknown[]): JourneyDatasetReader => {
  let index = 0;
  return {
    readCurrent: () => {
      const current = datasets[Math.min(index++, datasets.length - 1)];
      return Promise.resolve(current);
    },
    readRevision: () => Promise.resolve(null),
  };
};

const createPort = (
  reader: JourneyDatasetReader | JourneyDatasetReadPort,
  routes: LastTrainRoutePorts,
  buildServiceDateContext = serviceDateContext,
  routeExecutionFor = (value: ToolExecutionContext): ToolExecutionContext => ({
    ...value,
    operation: 'walking_route',
  }),
): ReturnType<typeof createLastTrainJourneyPort> =>
  createLastTrainJourneyPort({
    reader,
    routes,
    buildServiceDateContext,
    clock: () => now,
    currentOriginRef: 'current-location',
    routeExecutionFor,
  });

const datasetPortFor = (
  datasets: readonly JourneyReadResult[],
  contexts: JourneyServiceDateContext[],
): JourneyDatasetReadPort => {
  let index = 0;
  return {
    read: (serviceDateContext) => {
      contexts.push(serviceDateContext);
      const result = datasets[Math.min(index++, datasets.length - 1)];
      if (result === undefined) throw new Error('test dataset result missing');
      return Promise.resolve(result);
    },
  };
};

describe('M14 LastTrainJourneyPort composition', () => {
  it('combines validated journey data with both directed route legs', async () => {
    const calls = { current: 0, station: 0, stationDestinations: [] as string[] };
    const readContexts: JourneyServiceDateContext[] = [];
    const port = createPort(
      datasetPortFor(
        [
          {
            status: 'known',
            revision: 1,
            journeys: [makeJourney('journey-1')],
          },
          {
            status: 'known',
            revision: 1,
            journeys: [makeJourney('journey-1')],
          },
        ],
        readContexts,
      ),
      routePorts(calls),
    );
    const result = await port.read(input, context, execution, { isCancelled: () => false });

    expect(result).toMatchObject({ status: 'ok', data: { journeyRef: 'journey-1' } });
    if (result.status === 'ok') {
      expect(result.data.placeToStationSeconds).toBe(180);
      expect(result.data.arrivePlaceAt).toBe('2026-09-10T12:10:00.000Z');
      expect(result.data.leaveBy).toBe('2026-09-10T14:44:00.000Z');
      expect(result.data.availableStaySeconds).toBe(9_240);
      expect(result.data.usable).toBe(true);
    }
    expect(calls).toEqual({ current: 1, station: 1, stationDestinations: ['station-a'] });
    expect(readContexts).toHaveLength(2);
    expect(readContexts.every((value) => value.isHoliday === false)).toBe(true);
    expect(readContexts.every((value) => value.serviceDate === '2026-09-10')).toBe(true);
  });

  it('requires an explicit service-date context instead of inventing a holiday', async () => {
    const calls = { current: 0, station: 0, stationDestinations: [] as string[] };
    const holidayOnlyJourney: JourneyRecord = {
      ...makeJourney('journey-holiday-only'),
      servicePattern: { weekdays: ['thursday'], holidayPolicy: 'only' },
    };
    const result = await createPort(
      readerFor([makeDataset([holidayOnlyJourney])]),
      routePorts(calls),
    ).read(input, context, execution, { isCancelled: () => false });

    expect(result).toMatchObject({ status: 'error', error: { code: 'CONSTRAINT_VIOLATION' } });
    expect(calls).toEqual({ current: 0, station: 0, stationDestinations: [] });
  });

  it('accepts the named dataset DO read boundary and preserves the route signal bridge identity', async () => {
    const routeCalls: ToolExecutionContext[] = [];
    const parentSignal = new AbortController().signal;
    const signalByExecution = new WeakMap<object, AbortSignal>();
    const routeParents: ToolExecutionContext[] = [];
    const calls = {
      current: 0,
      station: 0,
      stationDestinations: [] as string[],
      routeExecutions: routeCalls,
    };
    const routeExecutions: ToolExecutionContext[] = [];
    const readContexts: JourneyServiceDateContext[] = [];
    const result = await createPort(
      datasetPortFor(
        [
          { status: 'known', revision: 1, journeys: [makeJourney('journey-1')] },
          { status: 'known', revision: 1, journeys: [makeJourney('journey-1')] },
        ],
        readContexts,
      ),
      routePorts(calls),
      serviceDateContext,
      (value) => {
        routeParents.push(value);
        const routeExecution = { ...value, operation: 'walking_route' as const };
        signalByExecution.set(routeExecution, parentSignal);
        routeExecutions.push(routeExecution);
        return routeExecution;
      },
    ).read(input, context, execution, { isCancelled: () => false });

    expect(result).toMatchObject({ status: 'ok' });
    expect(routeExecutions).toHaveLength(2);
    expect(routeExecutions.every((value) => value.operation === 'walking_route')).toBe(true);
    expect(routeParents[0]).toBe(execution);
    expect(routeParents[1]).toBe(execution);
    expect(routeCalls[0]).toBe(routeExecutions[0]);
    expect(routeCalls[1]).toBe(routeExecutions[1]);
    expect(routeCalls.every((value) => signalByExecution.get(value) === parentSignal)).toBe(true);
    expect(readContexts).toHaveLength(2);
  });

  it('does not route when the dataset is absent or the caller is cancelled', async () => {
    const absentCalls = { current: 0, station: 0, stationDestinations: [] as string[] };
    const absent = await createPort(readerFor([null]), routePorts(absentCalls)).read(
      input,
      context,
      execution,
      { isCancelled: () => false },
    );
    expect(absent).toMatchObject({ status: 'error', error: { code: 'MISSING_EVIDENCE' } });
    expect(absentCalls).toEqual({ current: 0, station: 0, stationDestinations: [] });

    const cancelledCalls = { current: 0, station: 0, stationDestinations: [] as string[] };
    const cancelled = await createPort(
      readerFor([makeDataset([makeJourney('journey-1')])]),
      routePorts(cancelledCalls),
    ).read(input, context, execution, { isCancelled: () => true });
    expect(cancelled).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
    expect(cancelledCalls).toEqual({ current: 0, station: 0, stationDestinations: [] });
  });

  it('does not start route work when the dataset read observes cancellation', async () => {
    const calls = { current: 0, station: 0, stationDestinations: [] as string[] };
    let cancelled = false;
    const result = await createPort(
      {
        read: () => {
          cancelled = true;
          return Promise.resolve({
            status: 'known' as const,
            revision: 1,
            journeys: [makeJourney('journey-1')],
          });
        },
      },
      routePorts(calls),
    ).read(input, context, execution, { isCancelled: () => cancelled });

    expect(result).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
    expect(calls).toEqual({ current: 0, station: 0, stationDestinations: [] });
  });

  it('rejects a journey that changes while route evidence is being fetched', async () => {
    const calls = { current: 0, station: 0, stationDestinations: [] as string[] };
    const port = createPort(
      readerFor([makeDataset([makeJourney('journey-1')]), makeDataset([makeJourney('journey-2')])]),
      routePorts(calls),
    );
    const result = await port.read(input, context, execution, { isCancelled: () => false });

    expect(result).toMatchObject({ status: 'error', error: { code: 'STALE_EVIDENCE' } });
    expect(calls).toEqual({ current: 1, station: 1, stationDestinations: ['station-a'] });
  });

  it('runs the walking checks before reporting same-station not-applicable', async () => {
    const calls = { current: 0, station: 0, stationDestinations: [] as string[] };
    const sameStationInput = { ...input, fromStationRef: 'station-a', homeStationRef: 'station-a' };
    const sameStationContext = {
      ...context,
      preferences: { ...context.preferences, homeStationRef: 'station-a' },
    };
    const result = await createPort(
      readerFor([makeDataset([makeJourney('journey-1')]), makeDataset([makeJourney('journey-1')])]),
      routePorts(calls),
    ).read(sameStationInput, sameStationContext, execution, { isCancelled: () => false });

    expect(result).toMatchObject({ status: 'error', error: { code: 'CONSTRAINT_VIOLATION' } });
    expect(calls).toEqual({ current: 1, station: 1, stationDestinations: ['station-a'] });
  });
});
