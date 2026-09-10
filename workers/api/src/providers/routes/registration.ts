import {
  IsoTimestampSchema,
  ObservationContextSchema,
  WalkingRouteSchema,
  type CandidateId,
  type ClockPort,
  type HarnessContext,
  type ObservationContext,
  type ObservationRegistration,
  type ReadonlyStoredObservation,
  type WalkingRoute,
} from '@ima/core';
import type { CandidateObservationRegistryPort } from '@ima/core';
import * as v from 'valibot';

export type WalkingRouteObservationInput = Omit<
  ObservationRegistration,
  'freshUntil' | 'expiresAt' | 'retention'
>;

export type WalkingRouteObservationPolicy = (input: {
  readonly now: string;
  readonly observation: WalkingRouteObservationInput;
}) => Pick<ObservationRegistration, 'freshUntil' | 'expiresAt' | 'retention'> | undefined;

export type WalkingRouteRegistration = {
  readonly register: (
    candidateId: CandidateId,
    route: WalkingRoute,
    context: HarnessContext,
  ) => ReadonlyStoredObservation | undefined;
};

export type WalkingRouteRegistrationOptions = {
  readonly registry: CandidateObservationRegistryPort;
  readonly clock: ClockPort;
  /** The Host policy decides the provider and session retention window. */
  readonly observationPolicy: WalkingRouteObservationPolicy;
};

const observationContextFor = (
  context: HarnessContext,
  route: WalkingRoute,
): ObservationContext => ({
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
  capabilityVersion: context.capabilities.version,
  locationRevision: route.originRevision,
  originRef: route.originRef,
  homeStationRef: context.preferences.homeStationRef,
  minimumStayMinutes: context.preferences.minimumStayMinutes,
  timeContext: 'now',
});

const observationFor = (
  candidateId: CandidateId,
  route: WalkingRoute,
  context: HarnessContext,
): WalkingRouteObservationInput => {
  const observationContext = observationContextFor(context, route);
  if (!v.safeParse(ObservationContextSchema, observationContext).success) {
    throw new Error('walking route observation context is invalid');
  }
  if (!v.safeParse(IsoTimestampSchema, route.evaluatedAt).success) {
    throw new Error('walking route evaluation time is invalid');
  }
  return {
    scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
    candidateId,
    field: 'walking_route',
    value: route,
    basis: 'computed',
    sourceUpdatedAt: null,
    context: observationContext,
    sources: [
      {
        provider: 'google_routes',
        recordRef: 'compute-route-matrix',
        attribution: null,
        publicUrl: null,
      },
    ],
  };
};

/** Registers only validated Core route values; provider IDs never enter the observation. */
export const createWalkingRouteRegistration = (
  options: WalkingRouteRegistrationOptions,
): WalkingRouteRegistration => ({
  register: (candidateId, route, context) => {
    const parsedRoute = v.safeParse(WalkingRouteSchema, route);
    if (!parsedRoute.success) return undefined;
    const observation = observationFor(candidateId, parsedRoute.output, context);
    const policy = options.observationPolicy({ now: options.clock.now(), observation });
    if (policy === undefined) return undefined;
    const stored = options.registry.registerObservation({ ...observation, ...policy });
    if (
      !options.registry.restoreObservationReuse(
        { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
        candidateId,
        'walking_route',
        [stored.observationId],
      )
    ) {
      return undefined;
    }
    return stored;
  },
});
