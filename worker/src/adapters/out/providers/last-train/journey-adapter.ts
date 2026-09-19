import * as v from 'valibot';
import { calculateJourneyTiming } from '@worker/domain/travel/journey-calculation';
import {
  CandidateToStationWalkingRouteSchema,
  type DirectedWalkingRoutePort,
} from '@worker/application/ports/walking-route';
import {
  HarnessContextSchema,
  ToolExecutionContextSchema,
  type CancellationToken,
  type HarnessContext,
  type ToolExecutionContext,
} from '@worker/application/ports/context';
import { IsoTimestampSchema, OpaqueIdSchema } from '@worker/domain/primitives';
import {
  JourneyServiceDateContextSchema,
  type JourneyRecord,
  type JourneyServiceDateContext,
} from '@worker/domain/travel/journey';
import { LastTrainInfoSchema, WalkingRouteSchema } from '@worker/domain/places/place-values';
import {
  LastTrainJourneyInputSchema,
  type LastTrainJourneyInput,
  type LastTrainJourneyError,
  type LastTrainJourneyPort,
  type LastTrainJourneyResult,
  type WalkingRoutePort,
} from '@worker/application/ports/operations';
import { type Issue } from '@worker/domain/issue';
import {
  createJourneyReader,
  type JourneyReadResult,
} from '@worker/adapters/out/persistence/last-train/reader';
import type { JourneyDatasetReader } from '@worker/adapters/out/persistence/last-train/store';

/** The named JourneyDatasetDO exposes the same validated read result over RPC. */
export type JourneyDatasetReadPort = {
  readonly read: (context: JourneyServiceDateContext) => Promise<JourneyReadResult>;
};

/** Runtime production adds a cheap active-revision probe to the validated read surface. */
export type RuntimeJourneyDataset = JourneyDatasetReadPort & {
  readonly readRevision: () => Promise<number | null>;
};

export type JourneyDatasetSource = JourneyDatasetReader | JourneyDatasetReadPort;

export type JourneyServiceDateContextBuilder = (
  context: HarnessContext,
  input: LastTrainJourneyInput,
  now: string,
) => JourneyServiceDateContext | undefined;

export type LastTrainRoutePorts = {
  /** The existing M13 port owns its own route budget reservation. */
  readonly currentToCandidate: WalkingRoutePort;
  /** The existing M13 directed port owns its own route budget reservation. */
  readonly candidateToStation: DirectedWalkingRoutePort;
};

/**
 * Creates a Worker-owned child execution for a route attempt. The implementation may bind the
 * attempt's AbortSignal in a WeakMap, but the Core execution contract remains signal-free.
 */
export type LastTrainRouteExecutionFactory = (
  execution: ToolExecutionContext,
) => ToolExecutionContext;

export type LastTrainJourneyPortOptions = {
  readonly reader: JourneyDatasetSource;
  readonly routes: LastTrainRoutePorts;
  readonly buildServiceDateContext: JourneyServiceDateContextBuilder;
  readonly clock: () => string;
  /** Opaque Worker-owned reference; provider place IDs never enter this port. */
  readonly currentOriginRef: string;
  /** Worker-only signal bridge; AbortSignal never enters the Core Port call. */
  readonly routeExecutionFor: LastTrainRouteExecutionFactory;
  readonly signal?: AbortSignal;
};

const issue = (
  code: Issue['code'],
  path: string | null,
  message: string,
  missingFields: readonly string[] = [],
): Issue => ({
  code,
  path,
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [...missingFields],
});

const resultError = (error: Issue): LastTrainJourneyError => ({ status: 'error', error });

const cancelled = (): LastTrainJourneyError =>
  resultError(issue('CANCELLED', 'last_train', 'last-train journey read was cancelled'));

const isCancelled = (options: LastTrainJourneyPortOptions, cancellation: CancellationToken) =>
  cancellation.isCancelled() || options.signal?.aborted === true;

const readerIssue = (result: Exclude<JourneyReadResult, { status: 'known' }>): Issue => {
  if (result.status === 'error') {
    return issue(
      'UPSTREAM_UNAVAILABLE',
      'journey.dataset',
      'last-train journey data is unavailable',
      ['journey'],
    );
  }
  if (result.status === 'not_applicable') {
    return issue(
      'CONSTRAINT_VIOLATION',
      'journey.stations',
      'last-train data is not applicable when the stations are the same',
    );
  }
  switch (result.availability.reason) {
    case 'missing':
      return issue('MISSING_EVIDENCE', 'journey', 'last-train journey is not registered', [
        'journey',
      ]);
    case 'stale':
      return issue('STALE_EVIDENCE', 'journey.verifiedAt', 'last-train journey evidence is stale', [
        'verifiedAt',
      ]);
    case 'not_operating':
      return issue(
        'CONSTRAINT_VIOLATION',
        'journey.servicePattern',
        'last-train journey does not operate for this service date',
      );
    case 'invalid':
      return issue('INVALID_EVIDENCE', 'journey', 'last-train journey data is invalid');
  }
};

const failureForRead = (result: JourneyReadResult): LastTrainJourneyError =>
  result.status === 'known'
    ? resultError(issue('INVALID_EVIDENCE', 'journey', 'journey read state is invalid'))
    : resultError(readerIssue(result));

const selectJourney = (journeys: readonly JourneyRecord[]): JourneyRecord | undefined =>
  [...journeys].sort((left, right) => {
    const departure = Date.parse(right.lastDepartureAt) - Date.parse(left.lastDepartureAt);
    return departure !== 0 ? departure : left.journeyRef.localeCompare(right.journeyRef);
  })[0];

const validNow = (clock: () => string): string | undefined => {
  const parsed = v.safeParse(IsoTimestampSchema, clock());
  return parsed.success ? parsed.output : undefined;
};

const buildContext = (
  options: LastTrainJourneyPortOptions,
  context: HarnessContext,
  input: LastTrainJourneyInput,
  now: string,
): JourneyServiceDateContext | undefined => {
  const built = options.buildServiceDateContext(context, input, now);
  const parsed = v.safeParse(JourneyServiceDateContextSchema, built);
  if (!parsed.success || Date.parse(parsed.output.now) !== Date.parse(now)) return undefined;
  if (
    parsed.output.fromStationRef !== input.fromStationRef ||
    parsed.output.homeStationRef !== input.homeStationRef
  ) {
    return undefined;
  }
  return parsed.output;
};

const readLatest = async (
  options: LastTrainJourneyPortOptions,
  context: JourneyServiceDateContext,
): Promise<JourneyReadResult> => {
  try {
    if ('read' in options.reader) return await options.reader.read(context);
    return await createJourneyReader(options.reader).read(context);
  } catch {
    return {
      status: 'error',
      code: 'STORAGE_UNAVAILABLE',
      revision: null,
      message: 'journey dataset storage is unavailable',
    };
  }
};

const routeCallFor = (
  options: LastTrainJourneyPortOptions,
  execution: ToolExecutionContext,
): ToolExecutionContext | undefined => {
  try {
    const routeCall = options.routeExecutionFor(execution);
    const parsed = v.safeParse(ToolExecutionContextSchema, routeCall);
    if (!parsed.success || parsed.output.operation !== 'walking_route') return undefined;
    if (
      parsed.output.threadId !== execution.threadId ||
      parsed.output.turnId !== execution.turnId ||
      parsed.output.revision !== execution.revision
    ) {
      return undefined;
    }
    // Validate without returning Valibot's cloned output: the Worker signal bridge keys the
    // attempt AbortSignal by this exact child execution object.
    return routeCall;
  } catch {
    return undefined;
  }
};

/**
 * Composes the Core last-train port from the validated Worker dataset and the M13 route ports.
 * Route ports perform the only provider budget reservations; this adapter does not reserve them
 * a second time. The service-date builder is required so holiday knowledge is never invented.
 */
export const createLastTrainJourneyPort = (
  options: LastTrainJourneyPortOptions,
): LastTrainJourneyPort => ({
  async read(
    input: LastTrainJourneyInput,
    context: HarnessContext,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<LastTrainJourneyResult> {
    const parsedInput = v.safeParse(LastTrainJourneyInputSchema, input);
    const parsedContext = v.safeParse(HarnessContextSchema, context);
    const parsedExecution = v.safeParse(ToolExecutionContextSchema, execution);
    if (!parsedInput.success || !parsedContext.success || !parsedExecution.success) {
      return resultError(issue('INVALID_ARGUMENT', 'last_train', 'last-train input is invalid'));
    }
    if (
      parsedExecution.output.operation !== 'last_train' ||
      parsedExecution.output.threadId !== parsedContext.output.threadId ||
      parsedExecution.output.turnId !== parsedContext.output.turnId ||
      parsedExecution.output.revision !== parsedContext.output.revision
    ) {
      return resultError(
        issue('STALE_TURN', 'last_train', 'last-train execution context is stale'),
      );
    }
    if (!v.safeParse(OpaqueIdSchema, options.currentOriginRef).success) {
      return resultError(
        issue('MISSING_CONTEXT', 'last_train.originRef', 'current origin is unavailable'),
      );
    }
    if (!parsedContext.output.capabilities.lastTrain) {
      return resultError(
        issue('UNSUPPORTED_FIELD', 'last_train', 'last-train capability is disabled'),
      );
    }
    if (
      (parsedContext.output.preferences.homeStationRef !== null &&
        parsedContext.output.preferences.homeStationRef !== parsedInput.output.homeStationRef) ||
      (parsedContext.output.preferences.minimumStayMinutes !== null &&
        parsedContext.output.preferences.minimumStayMinutes !==
          parsedInput.output.minimumStayMinutes)
    ) {
      return resultError(
        issue(
          'CONSTRAINT_VIOLATION',
          'last_train.preferences',
          'effective turn conditions do not match the request',
        ),
      );
    }
    if (isCancelled(options, cancellation)) return cancelled();

    const firstNow = validNow(options.clock);
    const firstContext =
      firstNow === undefined
        ? undefined
        : buildContext(options, parsedContext.output, parsedInput.output, firstNow);
    if (firstContext === undefined) {
      return resultError(
        issue('MISSING_CONTEXT', 'journey.context', 'service-date context is unavailable'),
      );
    }
    const initial = await readLatest(options, firstContext);
    if (isCancelled(options, cancellation)) return cancelled();
    const notApplicable = initial.status === 'not_applicable';
    if (initial.status !== 'known' && !notApplicable) return failureForRead(initial);
    const journey = initial.status === 'known' ? selectJourney(initial.journeys) : undefined;
    if (journey === undefined && !notApplicable) {
      return resultError(
        issue('MISSING_EVIDENCE', 'journey', 'last-train journey is not registered'),
      );
    }

    const routeCancellation: CancellationToken = {
      isCancelled: () => isCancelled(options, cancellation),
    };
    const routeContext = parsedContext.output;
    const coordinates = routeContext.location.coordinates;
    if (
      coordinates === null ||
      (routeContext.location.status !== 'available' && routeContext.location.status !== 'reduced')
    ) {
      return resultError(issue('LOCATION_REQUIRED', 'location', 'current location is required'));
    }
    const currentRouteCall = routeCallFor(options, execution);
    if (currentRouteCall === undefined) {
      return resultError(
        issue('INVALID_ARGUMENT', 'walking_route', 'walking route execution context is invalid'),
      );
    }
    const current = await options.routes.currentToCandidate.compute(
      {
        originRef: options.currentOriginRef,
        originCoordinates: coordinates,
        originRevision: routeContext.location.revision,
        destinationCandidateId: parsedInput.output.candidateId,
      },
      routeContext,
      currentRouteCall,
      routeCancellation,
    );
    if (isCancelled(options, cancellation)) return cancelled();
    if (current.status === 'error') return current;
    const currentRoute = v.safeParse(WalkingRouteSchema, current.data);
    if (
      !currentRoute.success ||
      currentRoute.output.destinationCandidateId !== parsedInput.output.candidateId
    ) {
      return resultError(
        issue('SCHEMA_MISMATCH', 'walking_route.current', 'current walking route is invalid'),
      );
    }

    const stationRouteCall = routeCallFor(options, execution);
    if (stationRouteCall === undefined) {
      return resultError(
        issue('INVALID_ARGUMENT', 'walking_route', 'walking route execution context is invalid'),
      );
    }
    const station = await options.routes.candidateToStation.computeDirected(
      {
        legs: [
          {
            kind: 'candidate_to_station',
            originCandidateId: parsedInput.output.candidateId,
            originRef: parsedInput.output.candidateId,
            destinationStationRef: parsedInput.output.fromStationRef,
          },
        ],
      },
      routeContext,
      stationRouteCall,
      routeCancellation,
    );
    if (isCancelled(options, cancellation)) return cancelled();
    if (station.status === 'error') return station;
    const stationItem = station.data.find(
      (item): item is Extract<typeof item, { kind: 'route'; leg: 'candidate_to_station' }> =>
        item.kind === 'route' &&
        item.leg === 'candidate_to_station' &&
        item.route.originCandidateId === parsedInput.output.candidateId &&
        item.route.destinationStationRef === parsedInput.output.fromStationRef,
    );
    if (stationItem === undefined) {
      return resultError(
        station.warnings[0] ??
          issue(
            'MISSING_EVIDENCE',
            'walking_route.candidate_to_station',
            'route to home station is unavailable',
          ),
      );
    }
    const stationRoute = v.safeParse(CandidateToStationWalkingRouteSchema, stationItem.route);
    if (!stationRoute.success) {
      return resultError(
        issue(
          'SCHEMA_MISMATCH',
          'walking_route.candidate_to_station',
          'station walking route is invalid',
        ),
      );
    }

    const latestNow = validNow(options.clock);
    const latestContext =
      latestNow === undefined
        ? undefined
        : buildContext(options, parsedContext.output, parsedInput.output, latestNow);
    if (latestNow === undefined || latestContext === undefined) {
      return resultError(
        issue('MISSING_CONTEXT', 'journey.context', 'service-date context expired'),
      );
    }
    const latestNowMilliseconds = Date.parse(latestNow);
    if (
      Date.parse(currentRoute.output.evaluatedAt) > latestNowMilliseconds ||
      Date.parse(stationRoute.output.evaluatedAt) > latestNowMilliseconds
    ) {
      return resultError(
        issue(
          'STALE_EVIDENCE',
          'walking_route.evaluatedAt',
          'walking route evaluation is ahead of the current clock',
          ['evaluatedAt'],
        ),
      );
    }
    const latestRead = await readLatest(options, latestContext);
    if (isCancelled(options, cancellation)) return cancelled();
    if (notApplicable) {
      if (latestRead.status !== 'not_applicable') {
        return resultError(
          issue(
            'STALE_EVIDENCE',
            'journey.stations',
            'station applicability changed during route read',
          ),
        );
      }
      return {
        status: 'not_applicable',
        reason: 'same_station',
        walkingVerificationRequired: true,
      };
    }
    if (journey === undefined) {
      return resultError(
        issue('MISSING_EVIDENCE', 'journey', 'last-train journey is not registered'),
      );
    }
    const latestJourney =
      latestRead.status === 'known'
        ? latestRead.journeys.find((item) => item.journeyRef === journey.journeyRef)
        : undefined;
    if (latestRead.status !== 'known' || latestJourney === undefined) {
      return resultError(
        issue('STALE_EVIDENCE', 'journey', 'last-train journey changed while routes were fetched', [
          'journey',
        ]),
      );
    }
    const timing = calculateJourneyTiming({
      journey: latestJourney,
      // Keep the latest clock so time spent fetching both routes reduces the available stay.
      // Core later checks that this generated arrival is not earlier than the current-route
      // observation's evaluatedAt plus its duration.
      evaluatedAt: latestNow,
      userToPlaceSeconds: currentRoute.output.durationSeconds,
      placeToStationSeconds: stationRoute.output.durationSeconds,
      minimumStayMinutes: parsedInput.output.minimumStayMinutes,
      closedAt: null,
      lastOrderAt: null,
    });
    if (timing.status === 'error') return resultError(timing.error);
    const info = v.safeParse(LastTrainInfoSchema, {
      serviceDate: latestJourney.serviceDate,
      fromStationRef: latestJourney.fromStationRef,
      homeStationRef: latestJourney.homeStationRef,
      journeyRef: latestJourney.journeyRef,
      lastDepartureAt: latestJourney.lastDepartureAt,
      arrivesHomeAt: latestJourney.arrivesHomeAt,
      transfers: latestJourney.transfers,
      placeToStationSeconds: stationRoute.output.durationSeconds,
      arrivePlaceAt: timing.data.arrivePlaceAt,
      leaveBy: timing.data.leaveBy,
      availableStaySeconds: timing.data.availableStaySeconds,
      minimumStayMinutes: parsedInput.output.minimumStayMinutes,
      usable: timing.data.usable,
    });
    if (!info.success) {
      return resultError(
        issue('SCHEMA_MISMATCH', 'last_train', 'computed last-train info is invalid'),
      );
    }
    const warnings = [...current.warnings, ...station.warnings, ...timing.warnings];
    return warnings.length === 0
      ? {
          status: 'ok',
          data: info.output,
          warnings: [],
          source: latestJourney.source,
          verifiedAt: latestJourney.verifiedAt,
        }
      : {
          status: 'partial',
          data: info.output,
          warnings,
          source: latestJourney.source,
          verifiedAt: latestJourney.verifiedAt,
        };
  },
});
