import {
  EventNameSchema,
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
} from '@ima/contracts';
import * as v from 'valibot';

export const nonNegativeInteger = (maximum: number) =>
  v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(maximum));

export const telemetryStatusSchema = v.picklist(['ok', 'partial', 'error', 'cancelled']);
export type TelemetryStatus = v.InferOutput<typeof telemetryStatusSchema>;

export const telemetryResultCodeSchema = v.picklist([
  'OK',
  'PARTIAL',
  'CANCELLED',
  'INVALID_ARGUMENT',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'RATE_LIMITED',
  'BUDGET_EXCEEDED',
  'EXPIRED',
  'INTERNAL',
]);
export type TelemetryResultCode = v.InferOutput<typeof telemetryResultCodeSchema>;

export const telemetryEventRecordSchema = v.strictObject({
  eventId: OpaqueIdSchema,
  threadId: OpaqueIdSchema,
  name: EventNameSchema,
  occurredAt: IsoTimestampSchema,
  turnId: v.optional(OpaqueIdSchema),
  revision: v.optional(RevisionSchema),
  candidateId: v.optional(OpaqueIdSchema),
  responseId: v.optional(OpaqueIdSchema),
  durationMs: v.optional(nonNegativeInteger(600_000)),
  status: v.optional(telemetryStatusSchema),
  code: v.optional(telemetryResultCodeSchema),
});
export type TelemetryEventRecord = v.InferOutput<typeof telemetryEventRecordSchema>;

export const telemetryProviderSchema = v.picklist(['places', 'hotpepper', 'photo', 'openai']);
export type TelemetryProvider = v.InferOutput<typeof telemetryProviderSchema>;

export const telemetryOperationSchema = v.picklist(['turn', 'call', 'provider']);
export type TelemetryOperation = v.InferOutput<typeof telemetryOperationSchema>;

export const traceRecordSchema = v.strictObject({
  schemaVersion: v.literal('v1'),
  traceId: OpaqueIdSchema,
  threadId: OpaqueIdSchema,
  turnId: OpaqueIdSchema,
  revision: v.optional(RevisionSchema),
  occurredAt: IsoTimestampSchema,
  operation: telemetryOperationSchema,
  provider: v.optional(telemetryProviderSchema),
  status: telemetryStatusSchema,
  resultCode: v.optional(telemetryResultCodeSchema),
  durationMs: v.optional(nonNegativeInteger(600_000)),
  tokenCount: v.optional(nonNegativeInteger(10_000_000)),
  apiElementCount: v.optional(nonNegativeInteger(10_000_000)),
  /** USD value from an external billing meter; never derived from token/API counts. */
  meteredCostUsd: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1_000_000))),
});
export type TraceRecord = v.InferOutput<typeof traceRecordSchema>;

export const telemetryAggregationSchema = v.strictObject({
  operation: telemetryOperationSchema,
  provider: v.nullable(telemetryProviderSchema),
  status: telemetryStatusSchema,
  calls: nonNegativeInteger(10_000_000),
  failures: nonNegativeInteger(10_000_000),
  durationTotalMs: nonNegativeInteger(6_000_000_000),
  durationMaxMs: nonNegativeInteger(600_000),
  durationUnknownCalls: nonNegativeInteger(10_000_000),
  tokenTotal: nonNegativeInteger(10_000_000_000),
  tokenMeasuredCalls: nonNegativeInteger(10_000_000),
  tokenUnknownCalls: nonNegativeInteger(10_000_000),
  apiElementTotal: nonNegativeInteger(10_000_000_000),
  apiElementMeasuredCalls: nonNegativeInteger(10_000_000),
  apiElementUnknownCalls: nonNegativeInteger(10_000_000),
  meteredCostUsdTotal: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1_000_000_000)),
  costMeasuredCalls: nonNegativeInteger(10_000_000),
  costUnknownCalls: nonNegativeInteger(10_000_000),
});
export type TelemetryAggregation = v.InferOutput<typeof telemetryAggregationSchema>;

export const parseTraceRecord = (input: unknown): TraceRecord | undefined => {
  const parsed = v.safeParse(traceRecordSchema, input);
  return parsed.success ? parsed.output : undefined;
};
