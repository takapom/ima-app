import * as v from 'valibot';
import { isWithinTelemetryRetention } from '@worker/telemetry/retention';
import {
  telemetryAggregationSchema,
  type TelemetryAggregation,
  type TraceRecord,
} from '@worker/telemetry/schema';
export { parseTraceRecord } from '@worker/telemetry/schema';
export type { TelemetryAggregation, TraceRecord } from '@worker/telemetry/schema';

export interface TelemetryTraceStore {
  write(record: TraceRecord, ownerScopeRef: string): Promise<void>;
  readSince(cutoff: string): Promise<readonly TraceRecord[]>;
  deleteBefore(cutoff: string): Promise<number>;
}

/** Aggregates already validated records; storage and retention scheduling stay outside this pure function. */
export const aggregateTelemetryTraces = (
  records: readonly TraceRecord[],
): readonly TelemetryAggregation[] => {
  const buckets = new Map<string, TelemetryAggregation>();
  for (const record of records) {
    const provider = record.provider ?? null;
    const key = `${record.operation}|${provider ?? ''}|${record.status}`;
    const current = buckets.get(key) ?? {
      operation: record.operation,
      provider,
      status: record.status,
      calls: 0,
      failures: 0,
      durationTotalMs: 0,
      durationMaxMs: 0,
      durationUnknownCalls: 0,
      tokenTotal: 0,
      tokenMeasuredCalls: 0,
      tokenUnknownCalls: 0,
      apiElementTotal: 0,
      apiElementMeasuredCalls: 0,
      apiElementUnknownCalls: 0,
      meteredCostUsdTotal: 0,
      costMeasuredCalls: 0,
      costUnknownCalls: 0,
    };
    const duration = record.durationMs;
    const tokenCount = record.tokenCount;
    const apiElementCount = record.apiElementCount;
    const meteredCostUsd = record.meteredCostUsd;
    const next = {
      ...current,
      calls: current.calls + 1,
      failures:
        current.failures + (record.status === 'error' || record.status === 'cancelled' ? 1 : 0),
      durationTotalMs: current.durationTotalMs + (duration ?? 0),
      durationMaxMs: Math.max(current.durationMaxMs, duration ?? 0),
      durationUnknownCalls: current.durationUnknownCalls + (duration === undefined ? 1 : 0),
      tokenTotal: current.tokenTotal + (tokenCount ?? 0),
      tokenMeasuredCalls: current.tokenMeasuredCalls + (tokenCount === undefined ? 0 : 1),
      tokenUnknownCalls: current.tokenUnknownCalls + (tokenCount === undefined ? 1 : 0),
      apiElementTotal: current.apiElementTotal + (apiElementCount ?? 0),
      apiElementMeasuredCalls:
        current.apiElementMeasuredCalls + (apiElementCount === undefined ? 0 : 1),
      apiElementUnknownCalls:
        current.apiElementUnknownCalls + (apiElementCount === undefined ? 1 : 0),
      meteredCostUsdTotal: current.meteredCostUsdTotal + (meteredCostUsd ?? 0),
      costMeasuredCalls: current.costMeasuredCalls + (meteredCostUsd === undefined ? 0 : 1),
      costUnknownCalls: current.costUnknownCalls + (meteredCostUsd === undefined ? 1 : 0),
    };
    buckets.set(key, v.parse(telemetryAggregationSchema, next));
  }
  return [...buckets.values()].sort((left, right) =>
    `${left.operation}|${left.provider ?? ''}|${left.status}`.localeCompare(
      `${right.operation}|${right.provider ?? ''}|${right.status}`,
    ),
  );
};

export const filterTelemetryRetention = (
  records: readonly TraceRecord[],
  now: string,
): readonly TraceRecord[] =>
  records.filter((record) => isWithinTelemetryRetention(record.occurredAt, now));
