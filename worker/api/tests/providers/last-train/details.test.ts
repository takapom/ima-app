import {
  type GetPlaceDetailsInput,
  type HarnessContext,
  type JourneyRecord,
  type JourneyServiceDateContext,
  type LastTrainJourneyInput,
  type LastTrainJourneyPort,
  type ToolExecutionContext,
} from '@ima/core';
import { describe, expect, it } from 'vitest';
import {
  createLastTrainDetailsPort,
  type LastTrainDetailsDispatcherOptions,
} from '@api/providers/last-train/details';
import {
  createLastTrainJourneyPort,
  type JourneyDatasetReadPort,
  type LastTrainRoutePorts,
} from '@api/providers/last-train/port';
import { createLastTrainObservationRegistrar } from '@api/providers/last-train/registration';
import type { JourneyReadResult } from '@api/providers/last-train/reader';
import {
  context as placesContext,
  execution as placesExecution,
  makeFixture,
  NOW,
  retention,
  SCOPE,
} from '../hot-pepper/adapter-fixtures';
const journey = (fromStationRef: string, homeStationRef: string): JourneyRecord => ({
  journeyRef: 'journey-details-1',
  fromStationRef,
  homeStationRef,
  serviceDate: '2026-09-10',
  servicePattern: { weekdays: ['thursday'], holidayPolicy: 'allowed' },
  lastDepartureAt: '2026-09-10T23:50:00+09:00',
  arrivesHomeAt: '2026-09-11T00:30:00+09:00',
  transfers: [],
  validFrom: '2026-09-01',
  validThrough: '2026-09-30',
  verifiedAt: '2026-09-05T12:00:00Z',
  source: {
    provider: 'fixture-railway',
    recordRef: 'timetable-details-1',
    attribution: 'Fixture timetable',
    publicUrl: 'https://example.com/timetable-details-1',
  },
});
const known = (record: JourneyRecord): JourneyReadResult => ({
  status: 'known',
  revision: 1,
  journeys: [record],
});

const sameStation = (): JourneyReadResult => ({
  status: 'not_applicable',
  revision: 1,
  availability: {
    status: 'not_applicable',
    reason: 'same_station',
    walkingVerificationRequired: true,
  },
});

const datasetFor = (
  results: readonly JourneyReadResult[],
  calls: { count: number },
): JourneyDatasetReadPort => {
  let index = 0;
  return {
    read: () => {
      calls.count += 1;
      const result = results[Math.min(index++, results.length - 1)];
      if (result === undefined) throw new Error('journey fixture is empty');
      return Promise.resolve(result);
    },
  };
};

const routesFor = (calls: { current: number; station: number }): LastTrainRoutePorts => ({
  currentToCandidate: {
    compute: (input) => {
      calls.current += 1;
      return Promise.resolve({
        status: 'ok' as const,
        data: {
          originRef: input.originRef,
          destinationCandidateId: input.destinationCandidateId,
          originRevision: input.originRevision,
          evaluatedAt: NOW,
          durationSeconds: 600,
          distanceMeters: 900,
          warnings: [],
        },
        warnings: [],
      });
    },
  },
  candidateToStation: {
    computeDirected: (input) => {
      calls.station += 1;
      const leg = input.legs[0];
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
              evaluatedAt: NOW,
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
  input: LastTrainJourneyInput,
  now: string,
): JourneyServiceDateContext => ({
  serviceDate: '2026-09-10',
  weekday: 'thursday',
  isHoliday: false,
  now,
  fromStationRef: input.fromStationRef,
  homeStationRef: input.homeStationRef,
});

const detailsContext = (
  overrides: Partial<HarnessContext['capabilities']> = {},
): HarnessContext => ({
  ...placesContext,
  preferences: {
    ...placesContext.preferences,
    homeStationRef: 'station-b',
    minimumStayMinutes: 20,
  },
  capabilities: {
    ...placesContext.capabilities,
    detailFields: ['identity', 'last_train'],
    lastTrain: true,
    ...overrides,
  },
});

const detailsInput = (
  candidateId: string,
  freshness: 'reuse_valid' | 'refresh' = 'refresh',
): GetPlaceDetailsInput => ({
  requests: [{ candidateId, fields: ['identity', 'last_train'] as const }],
  freshness,
  travelContext: {
    departure: 'now' as const,
    homeStationRef: 'station-b',
    minimumStayMinutes: 20,
  },
});

const onlyLastTrainInput = (
  candidateId: string,
  freshness: 'reuse_valid' | 'refresh' = 'refresh',
): GetPlaceDetailsInput => ({
  ...detailsInput(candidateId, freshness),
  requests: [{ candidateId, fields: ['last_train'] as const }],
});

const journeyFor = (
  results: readonly JourneyReadResult[],
  routeCalls: { current: number; station: number },
  datasetCalls: { count: number },
): LastTrainJourneyPort =>
  createLastTrainJourneyPort({
    reader: datasetFor(results, datasetCalls),
    routes: routesFor(routeCalls),
    buildServiceDateContext: serviceDateContext,
    clock: () => NOW,
    currentOriginRef: 'current-location',
    routeExecutionFor: (execution) => ({ ...execution, operation: 'walking_route' }),
  });

const makeOptions = (
  fixture: ReturnType<typeof makeFixture>,
  journeyPort: LastTrainJourneyPort,
): LastTrainDetailsDispatcherOptions => ({
  base: fixture.adapter,
  journey: journeyPort,
  registry: fixture.registry,
  registrar: createLastTrainObservationRegistrar({
    registry: fixture.registry,
    clock: { now: () => NOW },
    currentOriginRef: 'current-location',
    observationPolicy: () => ({
      freshUntil: '2026-09-10T12:00:00.000Z',
      expiresAt: '2026-09-10T23:00:00.000Z',
      retention,
    }),
  }),
  fromStationRefFor: () => 'station-a',
  executionForLastTrain: (execution: ToolExecutionContext) => ({
    ...execution,
    operation: 'last_train',
  }),
});

const readDetails = async (
  options: LastTrainDetailsDispatcherOptions,
  input: ReturnType<typeof detailsInput>,
  context: HarnessContext = detailsContext(),
  execution: ToolExecutionContext = placesExecution,
  cancellation: { readonly isCancelled: () => boolean } = { isCancelled: () => false },
) => createLastTrainDetailsPort(options).read(input, context, execution, cancellation);

describe('M14 last-train details composition', () => {
  it('partitions base fields, computes last train, and registers timetable provenance', async () => {
    const fixture = makeFixture();
    const routeCalls = { current: 0, station: 0 };
    const datasetCalls = { count: 0 };
    const candidateId = fixture.candidateIds[0] ?? '';
    const options = makeOptions(
      fixture,
      journeyFor(
        [known(journey('station-a', 'station-b')), known(journey('station-a', 'station-b'))],
        routeCalls,
        datasetCalls,
      ),
    );
    const result = await readDetails(options, detailsInput(candidateId));
    expect(result?.status).toBe('ok');
    if (result?.status !== 'ok') return;
    expect(result.data.items[0]?.fields.last_train).toMatchObject({
      status: 'known',
      observations: [
        {
          field: 'last_train',
          sources: [{ provider: 'fixture-railway', recordRef: 'timetable-details-1' }],
          sourceUpdatedAt: '2026-09-05T12:00:00Z',
        },
      ],
    });
    expect(fixture.calls).toHaveLength(1);
    expect(routeCalls).toEqual({ current: 1, station: 1 });
    expect(datasetCalls.count).toBe(2);
  });

  it('does not reuse a last-train observation when the capability is disabled', async () => {
    const fixture = makeFixture();
    const routeCalls = { current: 0, station: 0 };
    const datasetCalls = { count: 0 };
    const candidateId = fixture.candidateIds[0] ?? '';
    const options = makeOptions(
      fixture,
      journeyFor(
        [known(journey('station-a', 'station-b')), known(journey('station-a', 'station-b'))],
        routeCalls,
        datasetCalls,
      ),
    );
    const first = await readDetails(options, detailsInput(candidateId));
    expect(first?.status).toBe('ok');
    const disabled = await readDetails(
      options,
      detailsInput(candidateId, 'reuse_valid'),
      detailsContext({ detailFields: ['identity'], lastTrain: false }),
    );

    expect(disabled?.status).toBe('partial');
    if (disabled?.status !== 'partial') return;
    expect(disabled.data.items[0]?.fields.last_train).toMatchObject({
      status: 'error',
      error: { code: 'UNSUPPORTED_FIELD' },
    });
    expect(routeCalls).toEqual({ current: 1, station: 1 });
    expect(datasetCalls.count).toBe(2);
  });

  it('rejects an explicit travel condition that differs from the active turn before reuse', async () => {
    const fixture = makeFixture();
    const routeCalls = { current: 0, station: 0 };
    const datasetCalls = { count: 0 };
    const candidateId = fixture.candidateIds[0] ?? '';
    const options = makeOptions(
      fixture,
      journeyFor(
        [known(journey('station-a', 'station-b')), known(journey('station-a', 'station-b'))],
        routeCalls,
        datasetCalls,
      ),
    );
    const result = await readDetails(options, {
      ...detailsInput(candidateId, 'reuse_valid'),
      travelContext: {
        departure: 'now',
        homeStationRef: 'station-other',
        minimumStayMinutes: 20,
      },
    });
    expect(result?.status).toBe('partial');
    if (result?.status !== 'partial') return;
    expect(result.data.items[0]?.fields.last_train).toMatchObject({
      status: 'error',
      error: { code: 'CONSTRAINT_VIOLATION' },
    });
    expect(routeCalls).toEqual({ current: 0, station: 0 });
    expect(datasetCalls.count).toBe(0);
  });

  it('rejects a stale execution before attempting observation reuse', async () => {
    const fixture = makeFixture();
    const routeCalls = { current: 0, station: 0 };
    const datasetCalls = { count: 0 };
    const candidateId = fixture.candidateIds[0] ?? '';
    const options = makeOptions(
      fixture,
      journeyFor(
        [known(journey('station-a', 'station-b')), known(journey('station-a', 'station-b'))],
        routeCalls,
        datasetCalls,
      ),
    );
    const onlyLastTrain = onlyLastTrainInput(candidateId);
    const first = await readDetails(options, onlyLastTrain);
    expect(first?.status).toBe('ok');
    const stale = await readDetails(
      options,
      { ...onlyLastTrain, freshness: 'reuse_valid' },
      detailsContext(),
      { ...placesExecution, turnId: 'stale-turn' },
    );

    expect(stale).toMatchObject({ status: 'error', error: { code: 'STALE_TURN' } });
    expect(routeCalls).toEqual({ current: 1, station: 1 });
    expect(datasetCalls.count).toBe(2);
  });

  it('caps observation freshness at the Core timetable verification window', async () => {
    const fixture = makeFixture();
    const routeCalls = { current: 0, station: 0 };
    const datasetCalls = { count: 0 };
    const candidateId = fixture.candidateIds[0] ?? '';
    const options = makeOptions(
      fixture,
      journeyFor(
        [
          known({ ...journey('station-a', 'station-b'), verifiedAt: '2026-09-03T14:00:00Z' }),
          known({ ...journey('station-a', 'station-b'), verifiedAt: '2026-09-03T14:00:00Z' }),
        ],
        routeCalls,
        datasetCalls,
      ),
    );
    const bounded = {
      ...options,
      registrar: createLastTrainObservationRegistrar({
        registry: fixture.registry,
        clock: fixture.clock,
        currentOriginRef: 'current-location',
        observationPolicy: () => ({
          freshUntil: '2026-09-30T00:00:00.000Z',
          expiresAt: '2026-09-30T00:00:00.000Z',
          retention: {
            ...retention,
            sessionExpiresAt: '2026-09-30T00:00:00.000Z',
            freshUntil: '2026-09-30T00:00:00.000Z',
            displayUntil: '2026-09-30T00:00:00.000Z',
            retentionUntil: '2026-09-30T00:00:00.000Z',
            deletionScheduledAt: '2026-09-30T00:00:00.000Z',
          },
        }),
      }),
    };
    const onlyLastTrain = onlyLastTrainInput(candidateId);

    const first = await readDetails(bounded, onlyLastTrain);
    expect(first?.status).toBe('ok');
    const observation = fixture.registry.listObservations(SCOPE, candidateId)[0];
    expect(observation?.expiresAt).toBe('2026-09-10T14:00:00.000Z');
    fixture.clock.set('2026-09-10T13:59:59.999Z');
    const reused = await readDetails(bounded, { ...onlyLastTrain, freshness: 'reuse_valid' });
    expect(reused?.status).toBe('ok');
    expect(routeCalls).toEqual({ current: 1, station: 1 });
    fixture.clock.set('2026-09-10T14:00:00.000Z');
    await readDetails(bounded, { ...onlyLastTrain, freshness: 'reuse_valid' });
    expect(routeCalls).toEqual({ current: 2, station: 2 });
  });

  it('returns same-station as not-applicable without a constraint warning', async () => {
    const fixture = makeFixture();
    const routeCalls = { current: 0, station: 0 };
    const datasetCalls = { count: 0 };
    const candidateId = fixture.candidateIds[0] ?? '';
    const options = makeOptions(
      fixture,
      journeyFor([sameStation(), sameStation()], routeCalls, datasetCalls),
    );
    const sameStationOptions: LastTrainDetailsDispatcherOptions = {
      ...options,
      fromStationRefFor: () => 'station-b',
    };

    const result = await readDetails(sameStationOptions, detailsInput(candidateId));

    expect(result?.status).toBe('ok');
    if (result?.status !== 'ok') return;
    expect(result.data.items[0]?.fields.last_train).toEqual({
      status: 'not_applicable',
      reason: 'same station; walking verification is still required',
    });
    expect(result.warnings).toEqual([]);
    expect(routeCalls).toEqual({ current: 1, station: 1 });
    expect(fixture.registry.listObservations(SCOPE, candidateId)).toHaveLength(1);
  });

  it('does not register a journey result when cancellation arrives during the read', async () => {
    const fixture = makeFixture();
    const routeCalls = { current: 0, station: 0 };
    const datasetCalls = { count: 0 };
    const candidateId = fixture.candidateIds[0] ?? '';
    const routePort = journeyFor(
      [known(journey('station-a', 'station-b')), known(journey('station-a', 'station-b'))],
      routeCalls,
      datasetCalls,
    );
    const cancelled = { value: false };
    const options = makeOptions(fixture, {
      read: async (input, context, execution, cancellation) => {
        const result = await routePort.read(input, context, execution, cancellation);
        cancelled.value = true;
        return result;
      },
    });
    const onlyLastTrain = onlyLastTrainInput(candidateId);

    const result = await readDetails(options, onlyLastTrain, detailsContext(), placesExecution, {
      isCancelled: () => cancelled.value,
    });

    expect(result).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
    expect(fixture.registry.listObservations(SCOPE, candidateId)).toHaveLength(0);
    expect(routeCalls).toEqual({ current: 1, station: 1 });
  });

  it('keeps a valid base field when last-train provider data is partial', async () => {
    const fixture = makeFixture();
    fixture.setBody((id) => ({
      id,
      name: `店 ${id}`,
      lat: null,
      lng: null,
      budget: { average: 123 },
    }));
    const routeCalls = { current: 0, station: 0 };
    const datasetCalls = { count: 0 };
    const candidateId = fixture.candidateIds[0] ?? '';
    const options = makeOptions(
      fixture,
      journeyFor(
        [known(journey('station-a', 'station-b')), known(journey('station-a', 'station-b'))],
        routeCalls,
        datasetCalls,
      ),
    );

    const result = await readDetails(options, {
      ...detailsInput(candidateId),
      requests: [{ candidateId, fields: ['price', 'last_train'] as const }],
    });

    expect(result?.status).toBe('partial');
    if (result?.status !== 'partial') return;
    expect(result.data.items[0]?.fields.price).toMatchObject({
      status: 'error',
      error: { code: 'SCHEMA_MISMATCH' },
    });
    expect(result.data.items[0]?.fields.last_train).toMatchObject({ status: 'known' });
  });
});
