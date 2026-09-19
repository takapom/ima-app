import { describe, expect, it, vi } from 'vitest';
import { EventsRequestSchema } from '@ima/contracts';
import * as v from 'valibot';
import {
  createBestEffortEventsSink,
  createTelemetryEventsSink,
  sanitizeTelemetryEvent,
  type TelemetryEventRecord,
  type TelemetryEventStore,
} from '@worker/telemetry/events';
import {
  OPERATIONAL_FLAG_ENV,
  operationalCapabilityMode,
  operationalFlagEnabled,
  resolveOperationalFlags,
} from '@worker/composition/operational-flags';
import {
  aggregateTelemetryTraces,
  filterTelemetryRetention,
  parseTraceRecord,
  type TraceRecord,
} from '@worker/telemetry/trace';

class FixtureTelemetryEventStore implements TelemetryEventStore {
  readonly records: TelemetryEventRecord[] = [];

  write(record: TelemetryEventRecord, _ownerScopeRef: string): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }

  deleteBefore(cutoff: string): Promise<number> {
    const before = this.records.length;
    const cutoffMs = Date.parse(cutoff);
    const retained = this.records.filter((record) => Date.parse(record.occurredAt) >= cutoffMs);
    this.records.splice(0, this.records.length, ...retained);
    return Promise.resolve(before - retained.length);
  }
}

class FixtureTelemetryTraceStore {
  readonly records: TraceRecord[] = [];

  record(input: unknown): boolean {
    const record = parseTraceRecord(input);
    if (record === undefined) return false;
    this.records.push(record);
    return true;
  }

  deleteExpired(now: string): number {
    const before = this.records.length;
    const retained = filterTelemetryRetention(this.records, now);
    this.records.splice(0, this.records.length, ...retained);
    return before - retained.length;
  }
}

const now = '2026-09-10T12:00:00.000Z';
const context = {
  requestId: 'request-1',
  ownerScopeRef: 'owner-1',
  deviceId: 'device-1',
  appVersion: '1.0.0',
  serverNow: now,
  cancellation: { isCancelled: () => false },
  signal: new AbortController().signal,
};

const eventInput = (overrides: Record<string, unknown> = {}) =>
  v.parse(EventsRequestSchema, {
    schemaVersion: 'v1',
    requestId: 'request-1',
    threadId: 'thread-1',
    event: {
      eventId: 'event-1',
      name: 'search_failed',
      occurredAt: now,
      turnId: 'turn-1',
      durationMs: 120,
      status: 'error',
      ...overrides,
    },
  });

const storedEvent = (input: unknown) => {
  const event = sanitizeTelemetryEvent(input);
  if (event === undefined) throw new Error('test event did not sanitize');
  return event;
};

describe('M26 telemetry and operational flags', () => {
  it('keeps missing configuration disabled and never creates fixture fallback', () => {
    const missing = resolveOperationalFlags({});
    expect(missing.mode).toBe('disabled');
    expect(operationalFlagEnabled(missing, 'places')).toBe(false);
    expect(operationalCapabilityMode(missing, 'places')).toBe('disabled');

    const explicitFixture = resolveOperationalFlags({
      [OPERATIONAL_FLAG_ENV.mode]: 'fixture',
      [OPERATIONAL_FLAG_ENV.places]: 'true',
    });
    expect(operationalFlagEnabled(explicitFixture, 'places')).toBe(true);
    expect(operationalCapabilityMode(explicitFixture, 'places')).toBe('fixture');
  });

  it('lets a kill switch disable configured capabilities without changing their mode', () => {
    const flags = resolveOperationalFlags({
      [OPERATIONAL_FLAG_ENV.mode]: 'live',
      [OPERATIONAL_FLAG_ENV.places]: 'true',
      [OPERATIONAL_FLAG_ENV.killSwitch]: 'on',
    });
    expect(flags.mode).toBe('live');
    expect(flags.killSwitch).toBe(true);
    expect(operationalCapabilityMode(flags, 'places')).toBe('disabled');
  });

  it('fails closed when the kill switch value is malformed', () => {
    const flags = resolveOperationalFlags({
      [OPERATIONAL_FLAG_ENV.mode]: 'live',
      [OPERATIONAL_FLAG_ENV.places]: 'true',
      [OPERATIONAL_FLAG_ENV.killSwitch]: 'tru',
    });
    expect(flags.killSwitch).toBe(true);
    expect(operationalCapabilityMode(flags, 'places')).toBe('disabled');

    const explicitlyRunning = resolveOperationalFlags({
      [OPERATIONAL_FLAG_ENV.mode]: 'live',
      [OPERATIONAL_FLAG_ENV.places]: 'true',
      [OPERATIONAL_FLAG_ENV.killSwitch]: 'false',
    });
    expect(explicitlyRunning.killSwitch).toBe(false);
    expect(operationalCapabilityMode(explicitlyRunning, 'places')).toBe('live');
  });

  it('persists only the event allowlist and drops arbitrary error text', () => {
    const event = sanitizeTelemetryEvent(
      eventInput({ code: 'provider raw secret: photo-token-canary' }),
    );
    expect(event).toBeDefined();
    expect(event?.code).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain('photo-token-canary');
  });

  it('does not let event storage failure stop the caller', async () => {
    const failure = vi.fn();
    const sink = createBestEffortEventsSink(
      createTelemetryEventsSink(
        {
          write: () => Promise.reject(new Error('raw provider secret')),
          deleteBefore: () => Promise.resolve(0),
        },
        failure,
      ),
      failure,
    );
    await expect(sink.accept(eventInput(), context)).resolves.toBeUndefined();
    expect(failure).toHaveBeenCalledWith('write_failed');
    expect(failure).toHaveBeenCalledWith('sink_failed');
  });

  it('aggregates bounded latency/cost metrics and deletes records beyond seven days', () => {
    const traces = new FixtureTelemetryTraceStore();
    expect(
      traces.record({
        schemaVersion: 'v1',
        traceId: 'trace-old',
        threadId: 'thread-1',
        turnId: 'turn-1',
        occurredAt: '2026-09-02T12:00:00.000Z',
        operation: 'provider',
        provider: 'places',
        status: 'ok',
        durationMs: 90,
        tokenCount: 10,
        apiElementCount: 2,
        meteredCostUsd: 1,
      }),
    ).toBe(true);
    expect(
      traces.record({
        schemaVersion: 'v1',
        traceId: 'trace-new',
        threadId: 'thread-1',
        turnId: 'turn-1',
        occurredAt: now,
        operation: 'provider',
        provider: 'places',
        status: 'error',
        resultCode: 'PROVIDER_TIMEOUT',
        durationMs: 120,
        tokenCount: 20,
        apiElementCount: 3,
        meteredCostUsd: 2,
      }),
    ).toBe(true);
    expect(
      traces.record({
        schemaVersion: 'v1',
        traceId: 'trace-raw',
        threadId: 'thread-1',
        turnId: 'turn-1',
        occurredAt: now,
        operation: 'provider',
        provider: 'places',
        status: 'error',
        errorMessage: 'raw query and coordinates',
      }),
    ).toBe(false);
    expect(
      traces.record({
        schemaVersion: 'v1',
        traceId: 'trace-unknown-meter',
        threadId: 'thread-1',
        turnId: 'turn-1',
        occurredAt: now,
        operation: 'provider',
        provider: 'places',
        status: 'partial',
      }),
    ).toBe(true);

    const aggregates = aggregateTelemetryTraces(traces.records);
    expect(aggregates).toHaveLength(3);
    expect(aggregates.find((entry) => entry.status === 'error')).toMatchObject({
      calls: 1,
      durationTotalMs: 120,
      tokenTotal: 20,
      apiElementTotal: 3,
      meteredCostUsdTotal: 2,
      costMeasuredCalls: 1,
      costUnknownCalls: 0,
      tokenMeasuredCalls: 1,
      tokenUnknownCalls: 0,
      apiElementMeasuredCalls: 1,
      apiElementUnknownCalls: 0,
      failures: 1,
    });
    expect(aggregates.find((entry) => entry.status === 'partial')).toMatchObject({
      calls: 1,
      tokenTotal: 0,
      tokenMeasuredCalls: 0,
      tokenUnknownCalls: 1,
      apiElementTotal: 0,
      apiElementMeasuredCalls: 0,
      apiElementUnknownCalls: 1,
      meteredCostUsdTotal: 0,
      costMeasuredCalls: 0,
      costUnknownCalls: 1,
    });
    expect(traces.deleteExpired(now)).toBe(1);
    expect(traces.records).toHaveLength(2);
    expect(traces.records.map((record) => record.traceId)).toEqual(
      expect.arrayContaining(['trace-new', 'trace-unknown-meter']),
    );
  });

  it('supports seven-day event deletion through the storage boundary', async () => {
    const store = new FixtureTelemetryEventStore();
    await store.write(storedEvent(eventInput()), 'owner-1');
    await store.write(
      storedEvent(eventInput({ eventId: 'event-old', occurredAt: '2026-09-02T11:59:59.000Z' })),
      'owner-1',
    );
    await expect(store.deleteBefore('2026-09-03T12:00:00.000Z')).resolves.toBe(1);
    expect(store.records.map((record) => record.eventId)).toEqual(['event-1']);
  });
});
