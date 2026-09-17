import { IsoTimestampSchema } from '@ima/contracts';
import * as v from 'valibot';

export const TELEMETRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const telemetryCutoff = (now: string): string => {
  const parsed = v.safeParse(IsoTimestampSchema, now);
  if (!parsed.success) throw new Error('TELEMETRY_CLOCK_INVALID');
  return new Date(Date.parse(parsed.output) - TELEMETRY_RETENTION_MS).toISOString();
};

export const isWithinTelemetryRetention = (occurredAt: string, now: string): boolean => {
  const cutoff = Date.parse(telemetryCutoff(now));
  const occurred = Date.parse(occurredAt);
  return Number.isFinite(occurred) && occurred > cutoff && occurred <= Date.parse(now);
};
