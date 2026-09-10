import type {
  CandidateId,
  DirectedWalkingRoutePort,
  DirectedWalkingRouteResult,
  HarnessContext,
  Issue,
  Result,
  ToolExecutionContext,
  WalkingRoute,
  WalkingRoutePort,
  CancellationToken,
  WalkingRouteInput,
} from '@ima/core';
import type { WalkingRouteRegistration } from './registration';

export type RegisteredWalkingRoutePort = DirectedWalkingRoutePort & WalkingRoutePort;

const registrationIssue = (): Issue => ({
  code: 'MISSING_CONTEXT',
  path: 'walking_route',
  retryable: false,
  retryAfterMs: null,
  message: 'walking route observation policy is unavailable',
  missingFields: ['retention'],
});

const resultError = <T>(error: Issue): Result<T> => ({ status: 'error', error });

const cancelled = <T>(): Result<T> =>
  resultError({
    code: 'CANCELLED',
    path: 'walking_route',
    retryable: false,
    retryAfterMs: null,
    message: 'walking route registration was cancelled',
    missingFields: [],
  });

const register = (
  registration: WalkingRouteRegistration,
  candidateId: CandidateId,
  route: WalkingRoute,
  context: HarnessContext,
): boolean => {
  try {
    return registration.register(candidateId, route, context) !== undefined;
  } catch {
    return false;
  }
};

const registerCurrentRoutes = (
  result: Result<WalkingRoute>,
  context: HarnessContext,
  registration: WalkingRouteRegistration,
  cancellation: CancellationToken,
): Result<WalkingRoute> => {
  if (result.status === 'error') return result;
  if (cancellation.isCancelled()) return cancelled();
  return register(registration, result.data.destinationCandidateId, result.data, context)
    ? result
    : resultError(registrationIssue());
};

const registerDirectedRoutes = (
  result: Result<readonly DirectedWalkingRouteResult[]>,
  context: HarnessContext,
  registration: WalkingRouteRegistration,
  cancellation: CancellationToken,
): Result<readonly DirectedWalkingRouteResult[]> => {
  if (result.status === 'error') return result;
  if (cancellation.isCancelled()) return cancelled();
  const data: DirectedWalkingRouteResult[] = [];
  const warnings = [...result.warnings];
  for (const item of result.data) {
    if (item.kind !== 'route' || item.leg !== 'current_to_candidate') {
      data.push(item);
      continue;
    }
    if (cancellation.isCancelled()) return cancelled();
    const stored = register(registration, item.route.destinationCandidateId, item.route, context);
    if (stored) {
      data.push(item);
      continue;
    }
    data.push({
      kind: 'element_error',
      leg: item.leg,
      originRef: item.route.originRef,
      destinationRef: item.route.destinationCandidateId,
      reason: 'MISSING_CONTEXT',
    });
    warnings.push(registrationIssue());
  }
  return warnings.length === 0
    ? { status: 'ok', data, warnings: [] }
    : { status: 'partial', data, warnings };
};

/** Adds the Host's retention registration to the provider adapter without exposing it to Google. */
export const createRegisteredWalkingRoutePort = (options: {
  readonly port: RegisteredWalkingRoutePort;
  readonly registration: WalkingRouteRegistration;
}): RegisteredWalkingRoutePort => ({
  computeDirected: async (
    input,
    context,
    execution,
    cancellation,
  ): Promise<Result<readonly DirectedWalkingRouteResult[]>> =>
    registerDirectedRoutes(
      await options.port.computeDirected(input, context, execution, cancellation),
      context,
      options.registration,
      cancellation,
    ),
  compute: async (
    input: WalkingRouteInput,
    context: HarnessContext,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<Result<WalkingRoute>> =>
    registerCurrentRoutes(
      await options.port.compute(input, context, execution, cancellation),
      context,
      options.registration,
      cancellation,
    ),
});
