import type {
  CandidateObservationRegistryPort,
  CapabilitySnapshot,
  GetPlaceDetailsOutput,
  HarnessContext,
  Issue,
  PlaceDetailsPort,
  Result,
  ToolExecutionContext,
} from '@ima/core';
import {
  GetPlaceDetailsInputSchema,
  GetPlaceDetailsOutputSchema,
  WalkingRouteSchema,
} from '@ima/core';
import * as v from 'valibot';
import { createGoogleWalkingRouteAdapter } from '../../providers/routes/adapter';
import { createRegisteredWalkingRoutePort } from '../../providers/routes/composition';
import type { RouteBudgetBoundary } from '../../providers/routes/budget';
import {
  createWalkingRouteRegistration,
  type WalkingRouteObservationPolicy,
} from '../../providers/routes/registration';
import {
  createRegistryRouteWaypointResolver,
  unavailableStationWaypoint,
  type RouteWaypointResolver,
} from '../../providers/routes/resolver';
import { createGoogleRouteMatrixTransport } from '../../providers/routes/transport';
import type { RuntimeProviderTransportObserver } from '../../providers/telemetry/runtime-provider-trace-contract';
import {
  createRuntimeProviderComposition,
  type RuntimeLastTrainCompositionOptions,
  type RuntimeProviderComposition,
} from '../runtime-provider-composition';
import type { RuntimePhotoTokenPreparer } from '../runtime-response';

export type RuntimeProductionRouteOptions = {
  readonly apiKey: string;
  readonly fetcher?: typeof fetch;
  readonly budget: RouteBudgetBoundary;
  readonly clock: () => string;
  readonly resolveContext: () => HarnessContext;
  /** Optional for current-location routes; required only when last-train needs a station. */
  readonly resolveStationWaypoint?: RouteWaypointResolver;
  readonly currentOriginRefFor: (context: HarnessContext) => string | undefined;
  readonly observationPolicy: WalkingRouteObservationPolicy;
  readonly signal?: AbortSignal;
  readonly signalFor?: (execution: ToolExecutionContext) => AbortSignal | undefined;
  readonly routeExecutionFor?: (execution: ToolExecutionContext) => ToolExecutionContext;
  readonly providerTraceObserver?: RuntimeProviderTransportObserver;
};

export type RuntimeProductionProviderOptions = {
  readonly baseDetails: PlaceDetailsPort;
  readonly registry: CandidateObservationRegistryPort;
  readonly clock: () => string;
  readonly route?: RuntimeProductionRouteOptions;
  readonly lastTrain?: Omit<RuntimeLastTrainCompositionOptions, 'routes'>;
  readonly photos?: Parameters<typeof createRuntimeProviderComposition>[0]['photos'];
};

export type RuntimeProductionProviderComposition = {
  readonly details: PlaceDetailsPort;
  readonly routesEnabled: boolean;
  readonly lastTrainEnabled: boolean;
  readonly photosEnabled: boolean;
  readonly preparePhotoTokens?: RuntimePhotoTokenPreparer;
  readonly capabilitiesFor: RuntimeProviderComposition['capabilitiesFor'];
};

type RuntimeRouteAssembly = {
  readonly registered: RuntimeLastTrainCompositionOptions['routes'];
  readonly computeCurrent: PlaceDetailsPort;
  readonly routeExecutionFor: (execution: ToolExecutionContext) => ToolExecutionContext;
};

const routePortsFor = (
  options: RuntimeProductionProviderOptions,
): RuntimeRouteAssembly | undefined => {
  const route = options.route;
  if (route === undefined) return undefined;
  const routeSignals = new WeakMap<object, AbortSignal>();
  const childExecutionFor = (execution: ToolExecutionContext): ToolExecutionContext => {
    const child =
      route.routeExecutionFor?.(execution) ??
      ({ ...execution, operation: 'walking_route' as const } satisfies ToolExecutionContext);
    const signal = route.signalFor?.(execution);
    if (signal !== undefined) routeSignals.set(child, signal);
    return child;
  };
  const waypointResolver = createRegistryRouteWaypointResolver({
    registry: options.registry,
    resolveStationWaypoint: route.resolveStationWaypoint ?? unavailableStationWaypoint,
  });
  const adapter = createGoogleWalkingRouteAdapter({
    transport: createGoogleRouteMatrixTransport({
      apiKey: route.apiKey,
      timeoutMs: 4_000,
      ...(route.fetcher === undefined ? {} : { fetcher: route.fetcher }),
      ...(route.providerTraceObserver === undefined
        ? {}
        : { observer: route.providerTraceObserver }),
    }),
    budget: route.budget,
    clock: route.clock,
    resolveContext: route.resolveContext,
    waypointResolver,
    ...(route.signal === undefined ? {} : { signal: route.signal }),
    signalFor: (execution) => routeSignals.get(execution) ?? route.signalFor?.(execution),
  });
  const registration = createWalkingRouteRegistration({
    registry: options.registry,
    clock: { now: options.clock },
    observationPolicy: route.observationPolicy,
  });
  const registered = createRegisteredWalkingRoutePort({
    port: adapter,
    registration,
  });
  const computeCurrent: PlaceDetailsPort = {
    async read(input, context, execution, cancellation) {
      const parsed = v.safeParse(GetPlaceDetailsInputSchema, input);
      if (!parsed.success) return options.baseDetails.read(input, context, execution, cancellation);
      const routeRequests = parsed.output.requests.filter((request) =>
        request.fields.includes('walking_route'),
      );
      if (routeRequests.length === 0)
        return options.baseDetails.read(input, context, execution, cancellation);
      const baseRequests = parsed.output.requests
        .map((request) => ({
          ...request,
          fields: request.fields.filter((field) => field !== 'walking_route'),
        }))
        .filter((request) => request.fields.length > 0);
      const baseResult: Result<GetPlaceDetailsOutput> =
        baseRequests.length === 0
          ? { status: 'ok', data: { items: [] }, warnings: [] }
          : await options.baseDetails.read(
              { ...parsed.output, requests: baseRequests },
              context,
              execution,
              cancellation,
            );
      if (baseResult.status === 'error') return baseResult;
      const items = new Map(baseResult.data.items.map((item) => [item.candidateId, item]));
      const warnings: Issue[] = [...baseResult.warnings];
      const coordinates = context.location.coordinates;
      const originRef = route.currentOriginRefFor(context);
      if (coordinates === null || originRef === undefined) {
        for (const request of routeRequests) {
          const item = items.get(request.candidateId) ?? {
            candidateId: request.candidateId,
            fields: {},
          };
          item.fields.walking_route = {
            status: 'error',
            error: {
              code: 'LOCATION_REQUIRED',
              path: 'walking_route',
              retryable: false,
              retryAfterMs: null,
              message: 'current location is required for walking route',
              missingFields: ['location'],
            },
          };
          warnings.push(item.fields.walking_route.error);
          items.set(request.candidateId, item);
        }
      } else {
        const routeExecution = childExecutionFor(execution);
        const result = await adapter.computeDirected(
          {
            legs: routeRequests.map((request) => ({
              kind: 'current_to_candidate' as const,
              originRef,
              originCoordinates: coordinates,
              originRevision: context.location.revision,
              destinationCandidateId: request.candidateId,
            })),
          },
          context,
          routeExecution,
          cancellation,
        );
        if (result.status === 'error') return result;
        warnings.push(...result.warnings);
        for (const request of routeRequests) {
          const item = items.get(request.candidateId) ?? {
            candidateId: request.candidateId,
            fields: {},
          };
          const routeResult = result.data.find(
            (entry) =>
              entry.kind === 'route' &&
              entry.leg === 'current_to_candidate' &&
              entry.route.destinationCandidateId === request.candidateId,
          );
          if (routeResult === undefined || routeResult.kind !== 'route') {
            item.fields.walking_route = {
              status: 'error',
              error: {
                code: 'MISSING_EVIDENCE',
                path: 'walking_route',
                retryable: false,
                retryAfterMs: null,
                message: 'walking route is unavailable',
                missingFields: ['walking_route'],
              },
            };
            warnings.push(item.fields.walking_route.error);
          } else {
            const routeValue = v.safeParse(WalkingRouteSchema, routeResult.route);
            if (!routeValue.success) {
              item.fields.walking_route = {
                status: 'error',
                error: {
                  code: 'SCHEMA_MISMATCH',
                  path: 'walking_route',
                  retryable: false,
                  retryAfterMs: null,
                  message: 'walking route result is invalid',
                  missingFields: ['walking_route'],
                },
              };
              warnings.push(item.fields.walking_route.error);
            } else {
              const stored = registration.register(request.candidateId, routeValue.output, context);
              if (stored === undefined) {
                item.fields.walking_route = {
                  status: 'error',
                  error: {
                    code: 'MISSING_CONTEXT',
                    path: 'walking_route',
                    retryable: false,
                    retryAfterMs: null,
                    message: 'walking route observation policy is unavailable',
                    missingFields: ['retention'],
                  },
                };
                warnings.push(item.fields.walking_route.error);
              } else {
                item.fields.walking_route = {
                  status: 'known',
                  observations: [{ ...stored, value: routeValue.output }],
                };
              }
            }
          }
          items.set(request.candidateId, item);
        }
      }
      const output = v.safeParse(GetPlaceDetailsOutputSchema, { items: [...items.values()] });
      if (!output.success) {
        return {
          status: 'error',
          error: {
            code: 'SCHEMA_MISMATCH',
            path: 'walking_route',
            retryable: false,
            retryAfterMs: null,
            message: 'walking route details output is invalid',
            missingFields: [],
          },
        };
      }
      return warnings.length === 0
        ? { status: 'ok', data: output.output, warnings: [] }
        : { status: 'partial', data: output.output, warnings };
    },
  };
  return {
    registered: { currentToCandidate: registered, candidateToStation: registered },
    computeCurrent,
    routeExecutionFor: childExecutionFor,
  };
};

/**
 * Connects provider adapters only after every host-owned gate is present. The Core registry and
 * runtime budget remain the owners of candidate identity and paid-call admission.
 */
export const createRuntimeProductionProviderComposition = (
  options: RuntimeProductionProviderOptions,
): RuntimeProductionProviderComposition => {
  const routeAssembly = routePortsFor(options);
  const composition = createRuntimeProviderComposition({
    baseDetails: routeAssembly?.computeCurrent ?? options.baseDetails,
    registry: options.registry,
    clock: options.clock,
    ...(routeAssembly === undefined || options.lastTrain === undefined
      ? {}
      : {
          lastTrain: {
            ...options.lastTrain,
            routes: routeAssembly.registered,
            routeExecutionFor: routeAssembly.routeExecutionFor,
            executionForLastTrain: routeAssembly.routeExecutionFor,
          },
        }),
    ...(options.photos === undefined ? {} : { photos: options.photos }),
  });
  const routesEnabled = routeAssembly !== undefined;
  return {
    details: composition.details,
    routesEnabled: routeAssembly !== undefined,
    lastTrainEnabled: composition.lastTrainEnabled,
    photosEnabled: composition.photosEnabled,
    ...(composition.preparePhotoTokens === undefined
      ? {}
      : { preparePhotoTokens: composition.preparePhotoTokens }),
    capabilitiesFor: (base) => {
      const capabilities = composition.capabilitiesFor(base);
      const detailFields: CapabilitySnapshot['detailFields'] = capabilities.detailFields.filter(
        (field) => field !== 'walking_route',
      );
      if (routesEnabled) detailFields.push('walking_route');
      return { ...capabilities, detailFields, walkingRoute: routesEnabled };
    },
  };
};
