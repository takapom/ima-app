import * as v from 'valibot';
import {
  CandidateIdSchema,
  FiniteNumberSchema,
  IsoTimestampSchema,
  NonNegativeFiniteNumberSchema,
  NonNegativeSafeIntegerSchema,
  OpaqueIdSchema,
  RevisionSchema,
  Text,
} from '../domain/primitives';
import type { WalkingRoute } from '../domain/place-values';
import type { Result } from '../domain/result';
import type { CancellationToken, HarnessContext, ToolExecutionContext } from './context';

export const WalkingCoordinatesSchema = v.strictObject({
  lat: v.pipe(FiniteNumberSchema, v.minValue(-90), v.maxValue(90)),
  lng: v.pipe(FiniteNumberSchema, v.minValue(-180), v.maxValue(180)),
});
export type WalkingCoordinates = v.InferOutput<typeof WalkingCoordinatesSchema>;

export const WalkingRouteLegKindSchema = v.picklist([
  'current_to_candidate',
  'candidate_to_station',
]);
export type WalkingRouteLegKind = v.InferOutput<typeof WalkingRouteLegKindSchema>;

const CurrentToCandidateInputSchema = v.strictObject({
  kind: v.literal('current_to_candidate'),
  originRef: OpaqueIdSchema,
  originCoordinates: WalkingCoordinatesSchema,
  originRevision: RevisionSchema,
  destinationCandidateId: CandidateIdSchema,
  destinationCoordinates: WalkingCoordinatesSchema,
});

const CandidateToStationInputSchema = v.strictObject({
  kind: v.literal('candidate_to_station'),
  originCandidateId: CandidateIdSchema,
  originRef: OpaqueIdSchema,
  originCoordinates: WalkingCoordinatesSchema,
  destinationStationRef: OpaqueIdSchema,
  destinationCoordinates: WalkingCoordinatesSchema,
});

export const DirectedWalkingRouteLegInputSchema = v.union([
  CurrentToCandidateInputSchema,
  CandidateToStationInputSchema,
]);
export type DirectedWalkingRouteLegInput = v.InferOutput<typeof DirectedWalkingRouteLegInputSchema>;

export const DirectedWalkingRouteInputSchema = v.pipe(
  v.strictObject({
    legs: v.pipe(v.array(DirectedWalkingRouteLegInputSchema), v.minLength(1), v.maxLength(20)),
  }),
  v.check((input) => {
    const keys = input.legs.map((leg) =>
      leg.kind === 'current_to_candidate'
        ? `${leg.kind}:${leg.destinationCandidateId}`
        : `${leg.kind}:${leg.originCandidateId}:${leg.destinationStationRef}`,
    );
    return new Set(keys).size === keys.length;
  }, 'directed walking legs must be unique'),
);
export type DirectedWalkingRouteInput = v.InferOutput<typeof DirectedWalkingRouteInputSchema>;

export const CandidateToStationWalkingRouteSchema = v.strictObject({
  originCandidateId: CandidateIdSchema,
  originRef: OpaqueIdSchema,
  destinationStationRef: OpaqueIdSchema,
  evaluatedAt: IsoTimestampSchema,
  durationSeconds: NonNegativeSafeIntegerSchema,
  distanceMeters: NonNegativeFiniteNumberSchema,
  warnings: v.array(v.strictObject({ code: Text(80), message: Text(300) })),
});
export type CandidateToStationWalkingRoute = v.InferOutput<
  typeof CandidateToStationWalkingRouteSchema
>;

export type DirectedWalkingRouteResult =
  | {
      readonly kind: 'route';
      readonly leg: 'current_to_candidate';
      readonly route: WalkingRoute;
    }
  | {
      readonly kind: 'route';
      readonly leg: 'candidate_to_station';
      readonly route: CandidateToStationWalkingRoute;
    }
  | {
      readonly kind: 'unreachable' | 'element_error' | 'missing';
      readonly leg: WalkingRouteLegKind;
      readonly originRef: string;
      readonly destinationRef: string;
      readonly reason: string;
    };

export interface DirectedWalkingRoutePort {
  computeDirected(
    input: DirectedWalkingRouteInput,
    context: HarnessContext,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<Result<readonly DirectedWalkingRouteResult[]>>;
}
