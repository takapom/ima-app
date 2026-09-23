import * as v from 'valibot';
import {
  CapabilityVersionSchema,
  CallIdSchema,
  DetailFieldSchema,
  FiniteNumberSchema,
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  SafeIntegerSchema,
  Text,
  TurnIdSchema,
} from '@worker/domain/primitives';
import type { CandidateIdSchema } from '@worker/domain/primitives';

const LocationCoordinatesSchema = v.strictObject({
  lat: v.pipe(FiniteNumberSchema, v.minValue(-90), v.maxValue(90)),
  lng: v.pipe(FiniteNumberSchema, v.minValue(-180), v.maxValue(180)),
});

export const LocationContextSchema = v.pipe(
  v.strictObject({
    status: v.picklist(['available', 'denied', 'reduced', 'timeout', 'unavailable']),
    coordinates: v.nullable(LocationCoordinatesSchema),
    accuracyMeters: v.nullable(v.pipe(FiniteNumberSchema, v.minValue(0))),
    precise: v.boolean(),
    capturedAt: v.nullable(IsoTimestampSchema),
    revision: v.pipe(SafeIntegerSchema, v.minValue(0)),
  }),
  v.check((location) => {
    const available = location.status === 'available';
    const reduced = location.status === 'reduced';
    const hasCoordinates = location.coordinates !== null;
    const hasCapture = location.capturedAt !== null;
    return (
      (available
        ? hasCoordinates && hasCapture
        : reduced
          ? hasCoordinates && hasCapture && !location.precise
          : !hasCoordinates && !hasCapture && !location.precise) &&
      (location.accuracyMeters === null || hasCoordinates)
    );
  }, 'location status, coordinates, precision, and capture are inconsistent'),
);
export type LocationContext = v.InferOutput<typeof LocationContextSchema>;

export const PreferencesContextSchema = v.strictObject({
  homeStationRef: v.nullable(OpaqueIdSchema),
  maxWalkMinutes: v.nullable(v.pipe(SafeIntegerSchema, v.minValue(1), v.maxValue(180))),
  minimumStayMinutes: v.nullable(v.pipe(SafeIntegerSchema, v.minValue(1), v.maxValue(180))),
  areaText: v.nullable(v.pipe(v.string(), v.maxLength(160))),
  budget: v.nullable(v.picklist(['cheap', 'normal', 'any'])),
});
export type PreferencesContext = v.InferOutput<typeof PreferencesContextSchema>;

export const ExecutionBudgetSchema = v.pipe(
  v.strictObject({
    wallClockMs: v.pipe(SafeIntegerSchema, v.minValue(1), v.maxValue(60_000)),
    finalReserveMs: v.pipe(SafeIntegerSchema, v.minValue(0)),
    modelCallsRemaining: v.pipe(SafeIntegerSchema, v.minValue(0)),
    readCallsRemaining: v.pipe(SafeIntegerSchema, v.minValue(0)),
    providerHttpRequestsRemaining: v.pipe(SafeIntegerSchema, v.minValue(0)),
    retriesRemaining: v.pipe(SafeIntegerSchema, v.minValue(0)),
  }),
  v.check(
    (budget) => budget.finalReserveMs < budget.wallClockMs,
    'final answer reserve must fit inside the wall clock budget',
  ),
);
export type ExecutionBudget = v.InferOutput<typeof ExecutionBudgetSchema>;

export const CapabilitySnapshotSchema = v.strictObject({
  version: CapabilityVersionSchema,
  detailFields: v.pipe(
    v.array(DetailFieldSchema),
    v.maxLength(8),
    v.check((fields) => new Set(fields).size === fields.length, 'duplicate capability field'),
  ),
  supportedScopes: v.pipe(v.array(Text(120)), v.maxLength(32)),
});
export type CapabilitySnapshot = v.InferOutput<typeof CapabilitySnapshotSchema>;

/** Context injected by the Harness; coordinates and ownership never enter model input. */
export const HarnessContextSchema = v.strictObject({
  threadId: OpaqueIdSchema,
  turnId: TurnIdSchema,
  revision: RevisionSchema,
  serverNow: IsoTimestampSchema,
  ownerScopeRef: OpaqueIdSchema,
  location: LocationContextSchema,
  preferences: PreferencesContextSchema,
  budget: ExecutionBudgetSchema,
  capabilities: CapabilitySnapshotSchema,
});
export type HarnessContext = v.InferOutput<typeof HarnessContextSchema>;

/** Harness-issued identity for one operation invocation; model output cannot provide it. */
export const ToolExecutionContextSchema = v.strictObject({
  callId: CallIdSchema,
  operation: v.picklist(['search_places', 'get_place_details', 'submit_cards']),
  threadId: OpaqueIdSchema,
  turnId: TurnIdSchema,
  revision: RevisionSchema,
});
export type ToolExecutionContext = v.InferOutput<typeof ToolExecutionContextSchema>;

export const ModelContextSchema = v.strictObject({
  threadId: OpaqueIdSchema,
  turnId: TurnIdSchema,
  revision: RevisionSchema,
  serverNow: IsoTimestampSchema,
  location: v.strictObject({
    status: v.picklist(['available', 'denied', 'reduced', 'timeout', 'unavailable']),
    areaDescription: v.nullable(v.pipe(v.string(), v.maxLength(160))),
    accuracyMeters: v.nullable(v.pipe(FiniteNumberSchema, v.minValue(0))),
    capturedAt: v.nullable(IsoTimestampSchema),
    precise: v.boolean(),
  }),
  preferences: PreferencesContextSchema,
  capabilities: CapabilitySnapshotSchema,
});
export type ModelContext = v.InferOutput<typeof ModelContextSchema>;

export interface CancellationToken {
  isCancelled(): boolean;
}

export interface IdPort {
  nextCallId(): string;
  nextCandidateId(): string;
  nextObservationId(): string;
  nextResponseId(): string;
}

export interface RegistryIdPort extends IdPort {
  nextPlaceRef(): string;
}

export interface ClockPort {
  now(): string;
}

export type RegisteredCandidate = {
  candidateId: v.InferOutput<typeof CandidateIdSchema>;
  scopeRef: v.InferOutput<typeof OpaqueIdSchema>;
};
