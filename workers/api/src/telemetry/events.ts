import { EventsRequestSchema, type EventsRequest } from '@ima/contracts';
import type { EventsSink, HandlerContext } from '../http/handler';
import * as v from 'valibot';
import {
  telemetryEventRecordSchema,
  type TelemetryEventRecord,
  type TelemetryResultCode,
} from './schema';
export type { TelemetryEventRecord, TelemetryResultCode } from './schema';

export interface TelemetryEventStore {
  write(record: TelemetryEventRecord, ownerScopeRef: string): Promise<void>;
  deleteBefore(cutoff: string): Promise<number>;
}

export type TelemetryEventFailure = 'invalid_event' | 'write_failed';

const codeMap: ReadonlyMap<string, TelemetryResultCode> = new Map([
  ['OK', 'OK'],
  ['ok', 'OK'],
  ['PARTIAL', 'PARTIAL'],
  ['partial', 'PARTIAL'],
  ['CANCELLED', 'CANCELLED'],
  ['cancelled', 'CANCELLED'],
  ['INVALID_ARGUMENT', 'INVALID_ARGUMENT'],
  ['FORBIDDEN', 'FORBIDDEN'],
  ['NOT_FOUND', 'NOT_FOUND'],
  ['CONFLICT', 'CONFLICT'],
  ['PROVIDER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE'],
  ['PROVIDER_TIMEOUT', 'PROVIDER_TIMEOUT'],
  ['RATE_LIMITED', 'RATE_LIMITED'],
  ['BUDGET_EXCEEDED', 'BUDGET_EXCEEDED'],
  ['EXPIRED', 'EXPIRED'],
  ['INTERNAL', 'INTERNAL'],
]);

const classifiedCode = (code: string | undefined): TelemetryResultCode | undefined =>
  code === undefined ? undefined : codeMap.get(code);

/** Projects the public event to a fixed storage allowlist before any persistence call. */
export const sanitizeTelemetryEvent = (input: unknown): TelemetryEventRecord | undefined => {
  const parsed = v.safeParse(EventsRequestSchema, input);
  if (!parsed.success) return undefined;
  const event = parsed.output.event;
  const code = classifiedCode(event.code);
  const record = {
    eventId: event.eventId,
    threadId: parsed.output.threadId,
    name: event.name,
    occurredAt: event.occurredAt,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    ...(event.revision === undefined ? {} : { revision: event.revision }),
    ...(event.candidateId === undefined ? {} : { candidateId: event.candidateId }),
    ...(event.responseId === undefined ? {} : { responseId: event.responseId }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(code === undefined ? {} : { code }),
  };
  const checked = v.safeParse(telemetryEventRecordSchema, record);
  return checked.success ? checked.output : undefined;
};

export const createTelemetryEventsSink = (
  store: TelemetryEventStore,
  onFailure?: (failure: TelemetryEventFailure) => void,
): EventsSink => ({
  async accept(input: EventsRequest, _context: HandlerContext): Promise<void> {
    const record = sanitizeTelemetryEvent(input);
    if (record === undefined) {
      onFailure?.('invalid_event');
      return;
    }
    try {
      await store.write(record, _context.ownerScopeRef);
    } catch {
      onFailure?.('write_failed');
      throw new Error('TELEMETRY_WRITE_FAILED');
    }
  },
});

/** Makes event persistence best-effort so a metrics outage cannot stop the product action. */
export const createBestEffortEventsSink = (
  sink: EventsSink,
  onFailure?: (failure: 'sink_failed') => void,
): EventsSink => ({
  async accept(input: EventsRequest, context: HandlerContext): Promise<void> {
    try {
      await sink.accept(input, context);
    } catch {
      onFailure?.('sink_failed');
    }
  },
});
