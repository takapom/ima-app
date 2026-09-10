import type {
  CancellationToken,
  DirectedWalkingRoutePort,
  DirectedWalkingRouteResult,
  HarnessContext,
  Issue,
  Result,
  ToolExecutionContext,
  WalkingCoordinates,
  WalkingRoute,
  WalkingRouteInput,
  WalkingRoutePort,
} from '@ima/core';

const issue = (code: Issue['code'], path: string | null, message: string): Issue => ({
  code,
  path,
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [],
});

const resultError = <T>(error: Issue): Result<T> => ({ status: 'error', error });

export type WalkingRouteCoordinateResolver = (
  candidateId: string,
  context: HarnessContext,
) => WalkingCoordinates | undefined;

/** Bridges the new directed port to the existing current→candidate Core port. */
export const createWalkingRoutePortBridge = (
  directed: DirectedWalkingRoutePort,
  resolveCandidateCoordinates: WalkingRouteCoordinateResolver,
): WalkingRoutePort => ({
  async compute(
    input: WalkingRouteInput,
    context: HarnessContext,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<Result<WalkingRoute>> {
    const destinationCoordinates = resolveCandidateCoordinates(
      input.destinationCandidateId,
      context,
    );
    if (destinationCoordinates === undefined) {
      return resultError(
        issue(
          'UNKNOWN_CANDIDATE',
          'destinationCandidateId',
          'candidate coordinates are unavailable',
        ),
      );
    }
    const result = await directed.computeDirected(
      {
        legs: [
          {
            kind: 'current_to_candidate',
            originRef: input.originRef,
            originCoordinates: input.originCoordinates,
            originRevision: input.originRevision,
            destinationCandidateId: input.destinationCandidateId,
            destinationCoordinates,
          },
        ],
      },
      context,
      execution,
      cancellation,
    );
    if (result.status === 'error') return result;
    const route = result.data.find(
      (item): item is Extract<DirectedWalkingRouteResult, { kind: 'route' }> =>
        item.kind === 'route' && item.leg === 'current_to_candidate',
    );
    if (route === undefined || route.leg !== 'current_to_candidate') {
      return resultError(
        result.warnings[0] ??
          issue('MISSING_EVIDENCE', 'walking_route', 'walking route is unavailable'),
      );
    }
    return result.status === 'partial'
      ? { status: 'partial', data: route.route, warnings: result.warnings }
      : { status: 'ok', data: route.route, warnings: [] };
  },
});
