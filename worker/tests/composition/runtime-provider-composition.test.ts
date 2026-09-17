import type {
  CommittedResponse,
  CandidateRecord,
  GetPlaceDetailsInput,
  HarnessContext,
  JourneyRecord,
  LastTrainJourneyInput,
  RetentionMetadata,
  ToolExecutionContext,
} from '@ima/core';
import type { JourneyReadResult } from '@worker/adapters/outbound/persistence/last-train/reader';
import type { LastTrainRoutePorts } from '@worker/adapters/outbound/providers/last-train/journey-adapter';
import {
  createRuntimeLastTrainRevisionState,
  createRuntimeProviderComposition,
  type RuntimeJourneyDataset,
} from '@worker/composition/runtime-provider-composition';
import { describe, expect, it, vi } from 'vitest';
import {
  context as placesContext,
  execution as placesExecution,
  makeFixture,
  NOW,
  retention,
  SCOPE,
} from '../adapters/outbound/providers/hot-pepper/adapter-fixtures';

const detailsContext = (serverNow = NOW): HarnessContext => ({
  ...placesContext,
  serverNow,
  preferences: {
    ...placesContext.preferences,
    homeStationRef: 'station-b',
    minimumStayMinutes: 20,
  },
  capabilities: {
    ...placesContext.capabilities,
    detailFields: ['identity', 'last_train'],
    lastTrain: true,
  },
});

const journey = (
  journeyRef: string,
  lastDepartureAt = '2026-09-10T23:50:00+09:00',
): JourneyRecord => ({
  journeyRef,
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
  serviceDate: '2026-09-10',
  servicePattern: { weekdays: ['thursday'], holidayPolicy: 'allowed' },
  lastDepartureAt,
  arrivesHomeAt: '2026-09-11T00:30:00+09:00',
  transfers: [],
  validFrom: '2026-09-01',
  validThrough: '2026-09-30',
  verifiedAt: '2026-09-05T12:00:00Z',
  source: {
    provider: 'fixture-railway',
    recordRef: `timetable-${journeyRef}`,
    attribution: 'Fixture timetable',
    publicUrl: `https://example.com/${journeyRef}`,
  },
});

const routePorts = (clock: () => string): LastTrainRoutePorts => ({
  currentToCandidate: {
    compute: (input) =>
      Promise.resolve({
        status: 'ok' as const,
        data: {
          originRef: input.originRef,
          destinationCandidateId: input.destinationCandidateId,
          originRevision: input.originRevision,
          evaluatedAt: clock(),
          durationSeconds: 600,
          distanceMeters: 900,
          warnings: [],
        },
        warnings: [],
      }),
  },
  candidateToStation: {
    computeDirected: (input) => {
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
              evaluatedAt: clock(),
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

const observationPolicy = () => {
  const future = '2026-09-30T00:00:00.000Z';
  const futureRetention = {
    ...retention,
    sessionExpiresAt: future,
    freshUntil: future,
    displayUntil: future,
    retentionUntil: future,
    deletionScheduledAt: future,
  } satisfies RetentionMetadata;
  return { freshUntil: future, expiresAt: future, retention: futureRetention };
};

const datasetFor = (
  revision: number | null,
  current: () => JourneyRecord,
  reads: { count: number },
): RuntimeJourneyDataset => ({
  readRevision: () => Promise.resolve(revision),
  read: () => {
    reads.count += 1;
    if (revision === null) {
      return Promise.resolve({
        status: 'disabled',
        revision: null,
        availability: {
          status: 'disabled',
          reason: 'missing',
          issues: [],
          walkingVerificationRequired: true,
        },
      } satisfies JourneyReadResult);
    }
    return Promise.resolve({
      status: 'known',
      revision,
      journeys: [current()],
    } satisfies JourneyReadResult);
  },
});

const detailsInput = (
  candidateId: string,
  freshness: 'refresh' | 'reuse_valid',
): GetPlaceDetailsInput => ({
  requests: [{ candidateId, fields: ['identity', 'last_train'] }],
  freshness,
  travelContext: {
    departure: 'now' as const,
    homeStationRef: 'station-b',
    minimumStayMinutes: 20,
  },
});

const lastTrainOptions = (
  fixture: ReturnType<typeof makeFixture>,
  dataset: RuntimeJourneyDataset,
  revisionState: ReturnType<typeof createRuntimeLastTrainRevisionState>,
  clock: () => string,
  activeRevision: number | null,
  hooks: {
    readonly executionForLastTrain?: (execution: ToolExecutionContext) => ToolExecutionContext;
    readonly onRouteExecution?: (execution: ToolExecutionContext) => void;
    readonly fromStationRefFor?: (
      candidate: Readonly<CandidateRecord>,
      context: HarnessContext,
    ) => string | undefined;
  } = {},
) => ({
  activeRevision,
  dataset,
  revisionState,
  registry: fixture.registry,
  routes: routePorts(clock),
  buildServiceDateContext: (
    _context: HarnessContext,
    input: LastTrainJourneyInput,
    now: string,
  ) => ({
    serviceDate: '2026-09-10' as const,
    weekday: 'thursday' as const,
    isHoliday: false,
    now,
    fromStationRef: input.fromStationRef,
    homeStationRef: input.homeStationRef,
  }),
  clock,
  currentOriginRef: 'current-location',
  routeExecutionFor: (execution: ToolExecutionContext) => {
    hooks.onRouteExecution?.(execution);
    return { ...execution, operation: 'walking_route' as const };
  },
  fromStationRefFor: hooks.fromStationRefFor ?? (() => 'station-a'),
  executionForLastTrain:
    hooks.executionForLastTrain ??
    ((execution: ToolExecutionContext) => ({ ...execution, operation: 'last_train' as const })),
  observationPolicy,
});

describe('runtime M14/M15 provider composition', () => {
  it('wires named journey data and invalidates reuse on revision or evaluation-time changes', async () => {
    const fixture = makeFixture();
    let revision = 1;
    let currentJourney = journey('journey-1');
    const reads = { count: 0 };
    const clock = () => fixture.clock.now();
    const signal = new AbortController().signal;
    const signalByExecution = new WeakMap<object, AbortSignal>();
    const dataset: RuntimeJourneyDataset = {
      readRevision: () => Promise.resolve(revision),
      read: () => {
        reads.count += 1;
        return Promise.resolve({
          status: 'known',
          revision,
          journeys: [currentJourney],
        } satisfies JourneyReadResult);
      },
    };
    const composition = createRuntimeProviderComposition({
      baseDetails: fixture.adapter,
      registry: fixture.registry,
      clock,
      lastTrain: lastTrainOptions(
        fixture,
        dataset,
        createRuntimeLastTrainRevisionState(),
        clock,
        revision,
        {
          executionForLastTrain: (execution) => {
            const child = { ...execution, operation: 'last_train' as const };
            signalByExecution.set(child, signal);
            return child;
          },
          onRouteExecution: (execution) => {
            expect(execution.operation).toBe('last_train');
            expect(signalByExecution.get(execution)).toBe(signal);
          },
        },
      ),
    });
    const candidateId = fixture.candidateIds[0] ?? '';
    const cancellation = { isCancelled: () => false };
    const first = await composition.details.read(
      detailsInput(candidateId, 'refresh'),
      detailsContext(),
      placesExecution,
      cancellation,
    );
    expect(first.status).toBe('ok');
    const readsAfterRefresh = reads.count;

    const reused = await composition.details.read(
      detailsInput(candidateId, 'reuse_valid'),
      detailsContext(),
      placesExecution,
      cancellation,
    );
    expect(reused.status).toBe('ok');
    expect(reads.count).toBe(readsAfterRefresh);

    revision = 2;
    currentJourney = journey('journey-2', '2026-09-10T23:40:00+09:00');
    const afterRevision = await composition.details.read(
      detailsInput(candidateId, 'reuse_valid'),
      detailsContext(),
      placesExecution,
      cancellation,
    );
    expect(afterRevision.status).toBe('ok');
    expect(reads.count).toBeGreaterThan(readsAfterRefresh);
    if (afterRevision.status !== 'ok') return;
    expect(afterRevision.data.items[0]?.fields.last_train).toMatchObject({
      status: 'known',
      observations: [{ value: { journeyRef: 'journey-2' } }],
    });

    const readsAfterRevision = reads.count;
    fixture.clock.set('2026-09-10T03:00:00.000Z');
    const afterClock = await composition.details.read(
      detailsInput(candidateId, 'reuse_valid'),
      { ...detailsContext('2026-09-10T03:00:00.000Z') },
      placesExecution,
      cancellation,
    );
    expect(afterClock.status).toBe('ok');
    expect(reads.count).toBeGreaterThan(readsAfterRevision);
  });

  it('removes unconfigured last-train capability instead of seeding fixture data', () => {
    const fixture = makeFixture();
    const composition = createRuntimeProviderComposition({
      baseDetails: fixture.adapter,
      registry: fixture.registry,
      clock: () => NOW,
      lastTrain: lastTrainOptions(
        fixture,
        datasetFor(null, () => journey('unused'), { count: 0 }),
        createRuntimeLastTrainRevisionState(),
        () => NOW,
        null,
      ),
    });
    const capabilities = composition.capabilitiesFor(detailsContext().capabilities);
    expect(composition.lastTrainEnabled).toBe(false);
    expect(capabilities.lastTrain).toBe(false);
    expect(capabilities.detailFields).not.toContain('last_train');
  });

  it('tracks revision and station resolution per candidate before allowing reuse', async () => {
    const fixture = makeFixture(['place-a', 'place-b']);
    let stationForB = 'station-a';
    const invalidations = vi.spyOn(fixture.registry, 'invalidateObservationReuse');
    const clock = () => fixture.clock.now();
    const dataset: RuntimeJourneyDataset = {
      readRevision: () => Promise.resolve(1),
      read: () =>
        Promise.resolve({
          status: 'known',
          revision: 1,
          journeys: [journey('journey-per-candidate')],
        } satisfies JourneyReadResult),
    };
    const composition = createRuntimeProviderComposition({
      baseDetails: fixture.adapter,
      registry: fixture.registry,
      clock,
      lastTrain: lastTrainOptions(
        fixture,
        dataset,
        createRuntimeLastTrainRevisionState(),
        clock,
        1,
        {
          fromStationRefFor: (candidate) =>
            candidate.recordRef === 'place-b' ? stationForB : 'station-a',
        },
      ),
    });
    const cancellation = { isCancelled: () => false };
    await composition.details.read(
      {
        requests: fixture.candidateIds.map((candidateId) => ({
          candidateId,
          fields: ['last_train'],
        })),
        freshness: 'refresh',
      },
      detailsContext(),
      placesExecution,
      cancellation,
    );
    invalidations.mockClear();
    await composition.details.read(
      detailsInput(fixture.candidateIds[1] ?? '', 'reuse_valid'),
      detailsContext(),
      placesExecution,
      cancellation,
    );
    expect(invalidations.mock.calls.filter((call) => call[2] === 'last_train')).toHaveLength(0);

    stationForB = 'station-c';
    await composition.details.read(
      detailsInput(fixture.candidateIds[1] ?? '', 'reuse_valid'),
      detailsContext(),
      placesExecution,
      cancellation,
    );
    expect(invalidations.mock.calls).toContainEqual([SCOPE, fixture.candidateIds[1], 'last_train']);
  });

  it('does not probe or invalidate the registry for a stale execution boundary', async () => {
    const fixture = makeFixture();
    const readRevision = vi.fn(() => Promise.resolve(1));
    const composition = createRuntimeProviderComposition({
      baseDetails: fixture.adapter,
      registry: fixture.registry,
      clock: () => NOW,
      lastTrain: lastTrainOptions(
        fixture,
        {
          readRevision,
          read: () =>
            Promise.resolve({
              status: 'known',
              revision: 1,
              journeys: [journey('journey-stale-execution')],
            } satisfies JourneyReadResult),
        },
        createRuntimeLastTrainRevisionState(),
        () => NOW,
        1,
      ),
    });
    const result = await composition.details.read(
      detailsInput(fixture.candidateIds[0] ?? '', 'reuse_valid'),
      detailsContext(),
      { ...placesExecution, revision: 999 },
      { isCancelled: () => false },
    );
    expect(result.status).toBe('error');
    expect(readRevision).not.toHaveBeenCalled();
  });

  it('exposes the M15 preparer only with an authenticated device binding', async () => {
    const fixture = makeFixture();
    const issue = vi.fn(() => Promise.resolve('photo-token'));
    const composition = createRuntimeProviderComposition({
      baseDetails: fixture.adapter,
      registry: fixture.registry,
      clock: () => NOW,
      photos: {
        registry: fixture.registry,
        scope: SCOPE,
        codec: {
          issue,
          verify: () => Promise.reject(new Error('not used')),
        },
        deviceId: 'device-runtime-composition',
        sourceTurnId: 'turn-runtime-composition',
        sourceRevision: 1,
        photosEnabled: true,
        displayPolicyFor: () => undefined,
      },
    });
    const response: CommittedResponse = {
      presentation: 'keep',
      message: { text: '写真なし', evidenceIds: [], basis: 'conversational', evidence: [] },
    };
    const resolver = await composition.preparePhotoTokens?.({
      response,
      metadata: {
        threadId: SCOPE.threadId,
        turnId: 'turn-runtime-composition',
        responseId: 'response-runtime-composition',
        revision: 1,
      },
      now: NOW,
    });
    expect(composition.photosEnabled).toBe(true);
    expect(composition.capabilitiesFor(detailsContext().capabilities).detailFields).toContain(
      'photos',
    );
    expect(resolver).toBeDefined();
    expect(issue).not.toHaveBeenCalled();

    const disabled = createRuntimeProviderComposition({
      baseDetails: fixture.adapter,
      registry: fixture.registry,
      clock: () => NOW,
      photos: {
        registry: fixture.registry,
        scope: SCOPE,
        codec: {
          issue,
          verify: () => Promise.reject(new Error('not used')),
        },
        deviceId: 'device-runtime-composition',
        sourceTurnId: 'turn-runtime-composition',
        sourceRevision: 1,
        photosEnabled: false,
        displayPolicyFor: () => undefined,
      },
    });
    expect(disabled.photosEnabled).toBe(false);
    expect(disabled.preparePhotoTokens).toBeUndefined();
    expect(disabled.capabilitiesFor(detailsContext().capabilities).detailFields).not.toContain(
      'photos',
    );
  });
});
