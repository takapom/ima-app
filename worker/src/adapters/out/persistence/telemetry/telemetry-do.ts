import { IsoTimestampSchema, OpaqueIdSchema } from '@ima/contracts';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { TELEMETRY_RETENTION_MS } from '@worker/telemetry/retention';
import {
  telemetryEventRecordSchema,
  traceRecordSchema,
  type TelemetryEventRecord,
  type TraceRecord,
} from '@worker/telemetry/schema';
import type { TelemetryEventStore } from '@worker/telemetry/events';
import type { TelemetryTraceStore } from '@worker/telemetry/trace';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

type EventRow = {
  readonly owner_scope_ref: string;
  readonly event_id: string;
  readonly occurred_at_ms: number;
  readonly payload_json: string;
};

type TraceRow = {
  readonly owner_scope_ref: string;
  readonly trace_id: string;
  readonly occurred_at_ms: number;
  readonly payload_json: string;
};

type TelemetryDOStub = {
  writeEvent(ownerScopeRef: string, input: unknown): Promise<TelemetryWriteResult>;
  writeTrace(ownerScopeRef: string, input: unknown): Promise<TelemetryWriteResult>;
  readTraceSince(cutoff: string): Promise<TelemetryReadResult>;
  deleteExpired(cutoff: string): Promise<number>;
};

export type TelemetryStorageErrorCode =
  | 'TELEMETRY_OWNER_INVALID'
  | 'TELEMETRY_RECORD_INVALID'
  | 'TELEMETRY_TIMESTAMP_INVALID'
  | 'TELEMETRY_RECORD_FUTURE'
  | 'TELEMETRY_RECORD_EXPIRED'
  | 'TELEMETRY_EVENT_CONFLICT'
  | 'TELEMETRY_TRACE_CONFLICT'
  | 'TELEMETRY_STORAGE_FAILURE'
  | 'TELEMETRY_ROW_INVALID';

export type TelemetryWriteResult =
  { readonly ok: true } | { readonly ok: false; readonly code: TelemetryStorageErrorCode };

export type TelemetryReadResult =
  | { readonly ok: true; readonly records: readonly TraceRecord[] }
  | { readonly ok: false; readonly code: TelemetryStorageErrorCode };

export class TelemetryStorageError extends Error {
  readonly code: TelemetryStorageErrorCode;

  constructor(code: TelemetryStorageErrorCode) {
    super(code);
    this.name = 'TelemetryStorageError';
    this.code = code;
  }
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const ownerIsValid = (ownerScopeRef: string): boolean =>
  v.safeParse(OpaqueIdSchema, ownerScopeRef).success;

const timestampMs = (value: string): number => {
  const parsed = v.safeParse(IsoTimestampSchema, value);
  if (!parsed.success) throw new TelemetryStorageError('TELEMETRY_TIMESTAMP_INVALID');
  const milliseconds = Date.parse(parsed.output);
  if (!Number.isFinite(milliseconds)) {
    throw new TelemetryStorageError('TELEMETRY_TIMESTAMP_INVALID');
  }
  return milliseconds;
};

const ensureRecordWindow = (occurredAt: string, nowMs: number): void => {
  const occurredMs = timestampMs(occurredAt);
  if (occurredMs > nowMs) throw new TelemetryStorageError('TELEMETRY_RECORD_FUTURE');
  if (occurredMs <= nowMs - TELEMETRY_RETENTION_MS) {
    throw new TelemetryStorageError('TELEMETRY_RECORD_EXPIRED');
  }
};

const eventRecord = (input: unknown): TelemetryEventRecord => {
  const parsed = v.safeParse(telemetryEventRecordSchema, input);
  if (!parsed.success) throw new TelemetryStorageError('TELEMETRY_RECORD_INVALID');
  return parsed.output;
};

/**
 * Rows written before the routes and last-train providers were removed (#55) name a provider that
 * no longer exists. They expire with the retention window; until then a read skips them instead
 * of failing for every other row.
 */
const RETIRED_TELEMETRY_PROVIDERS: readonly unknown[] = ['routes', 'last_train'];

const isRetiredProviderRow = (payload: unknown): boolean =>
  typeof payload === 'object' &&
  payload !== null &&
  'provider' in payload &&
  RETIRED_TELEMETRY_PROVIDERS.includes(payload.provider);

const traceRecord = (input: unknown): TraceRecord => {
  const parsed = v.safeParse(traceRecordSchema, input);
  if (!parsed.success) throw new TelemetryStorageError('TELEMETRY_RECORD_INVALID');
  return parsed.output;
};

export class TelemetryDO extends DurableObject {
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_event (
          owner_scope_ref TEXT NOT NULL,
          event_id TEXT NOT NULL,
          occurred_at_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (owner_scope_ref, event_id)
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_trace (
          owner_scope_ref TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          occurred_at_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (owner_scope_ref, trace_id)
        )
      `);
      ctx.storage.sql.exec(
        'CREATE INDEX IF NOT EXISTS telemetry_event_time ON telemetry_event (occurred_at_ms)',
      );
      ctx.storage.sql.exec(
        'CREATE INDEX IF NOT EXISTS telemetry_trace_time ON telemetry_trace (occurred_at_ms)',
      );
      await this.scheduleCleanupAlarm(true, ctx.storage);
    });
  }

  private async scheduleCleanupAlarm(
    onlyAdvance: boolean,
    storage = this.ctx.storage,
  ): Promise<void> {
    const earliest = storage.sql
      .exec<{ readonly earliest_ms: number | null }>(
        `SELECT MIN(occurred_at_ms) AS earliest_ms
           FROM (
             SELECT occurred_at_ms FROM telemetry_event
             UNION ALL
             SELECT occurred_at_ms FROM telemetry_trace
           )`,
      )
      .toArray()[0]?.earliest_ms;
    const now = Date.now();
    const earliestExpiry =
      typeof earliest === 'number' ? earliest + TELEMETRY_RETENTION_MS : Number.POSITIVE_INFINITY;
    const nextAlarm = Math.max(now + 1, Math.min(now + CLEANUP_INTERVAL_MS, earliestExpiry));
    if (!onlyAdvance) {
      await storage.setAlarm(nextAlarm);
      return;
    }
    const existingAlarm = await storage.getAlarm();
    if (existingAlarm === null || existingAlarm > nextAlarm) {
      await storage.setAlarm(nextAlarm);
    }
  }

  async writeEvent(ownerScopeRef: string, input: unknown): Promise<TelemetryWriteResult> {
    await this.ready;
    try {
      if (!ownerIsValid(ownerScopeRef)) throw new TelemetryStorageError('TELEMETRY_OWNER_INVALID');
      const record = eventRecord(input);
      const occurredAtMs = timestampMs(record.occurredAt);
      ensureRecordWindow(record.occurredAt, Date.now());
      const payload = canonicalJson(record);
      this.ctx.storage.transactionSync(() => {
        const existing = this.ctx.storage.sql
          .exec<Pick<EventRow, 'payload_json'>>(
            'SELECT payload_json FROM telemetry_event WHERE owner_scope_ref = ? AND event_id = ?',
            ownerScopeRef,
            record.eventId,
          )
          .toArray()[0];
        if (existing !== undefined) {
          if (existing.payload_json === payload) return;
          throw new TelemetryStorageError('TELEMETRY_EVENT_CONFLICT');
        }
        this.ctx.storage.sql.exec(
          'INSERT INTO telemetry_event (owner_scope_ref, event_id, occurred_at_ms, payload_json) VALUES (?, ?, ?, ?)',
          ownerScopeRef,
          record.eventId,
          occurredAtMs,
          payload,
        );
      });
      await this.scheduleCleanupAlarm(true);
      return { ok: true };
    } catch (error: unknown) {
      if (error instanceof TelemetryStorageError) return { ok: false, code: error.code };
      return { ok: false, code: 'TELEMETRY_STORAGE_FAILURE' };
    }
  }

  async writeTrace(ownerScopeRef: string, input: unknown): Promise<TelemetryWriteResult> {
    await this.ready;
    try {
      if (!ownerIsValid(ownerScopeRef)) throw new TelemetryStorageError('TELEMETRY_OWNER_INVALID');
      const record = traceRecord(input);
      const occurredAtMs = timestampMs(record.occurredAt);
      ensureRecordWindow(record.occurredAt, Date.now());
      const payload = canonicalJson(record);
      this.ctx.storage.transactionSync(() => {
        const existing = this.ctx.storage.sql
          .exec<Pick<TraceRow, 'payload_json'>>(
            'SELECT payload_json FROM telemetry_trace WHERE owner_scope_ref = ? AND trace_id = ?',
            ownerScopeRef,
            record.traceId,
          )
          .toArray()[0];
        if (existing !== undefined) {
          if (existing.payload_json === payload) return;
          throw new TelemetryStorageError('TELEMETRY_TRACE_CONFLICT');
        }
        this.ctx.storage.sql.exec(
          'INSERT INTO telemetry_trace (owner_scope_ref, trace_id, occurred_at_ms, payload_json) VALUES (?, ?, ?, ?)',
          ownerScopeRef,
          record.traceId,
          occurredAtMs,
          payload,
        );
      });
      await this.scheduleCleanupAlarm(true);
      return { ok: true };
    } catch (error: unknown) {
      if (error instanceof TelemetryStorageError) return { ok: false, code: error.code };
      return { ok: false, code: 'TELEMETRY_STORAGE_FAILURE' };
    }
  }

  async readTraceSince(cutoff: string): Promise<TelemetryReadResult> {
    await this.ready;
    try {
      const requestedCutoffMs = timestampMs(cutoff);
      const minimumCutoffMs = Date.now() - TELEMETRY_RETENTION_MS;
      const effectiveCutoffMs = Math.max(requestedCutoffMs, minimumCutoffMs);
      const rows = this.ctx.storage.sql
        .exec<TraceRow>(
          'SELECT * FROM telemetry_trace WHERE occurred_at_ms > ? ORDER BY occurred_at_ms',
          effectiveCutoffMs,
        )
        .toArray();
      const records = rows.flatMap((row) => {
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload_json);
        } catch {
          throw new TelemetryStorageError('TELEMETRY_ROW_INVALID');
        }
        if (isRetiredProviderRow(payload)) return [];
        try {
          return [traceRecord(payload)];
        } catch {
          throw new TelemetryStorageError('TELEMETRY_ROW_INVALID');
        }
      });
      return { ok: true, records };
    } catch (error: unknown) {
      if (error instanceof TelemetryStorageError) return { ok: false, code: error.code };
      return { ok: false, code: 'TELEMETRY_STORAGE_FAILURE' };
    }
  }

  async deleteExpired(cutoff: string): Promise<number> {
    await this.ready;
    try {
      const cutoffMs = timestampMs(cutoff);
      if (cutoffMs > Date.now()) throw new TelemetryStorageError('TELEMETRY_TIMESTAMP_INVALID');
      return this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          'DELETE FROM telemetry_event WHERE occurred_at_ms <= ?',
          cutoffMs,
        );
        const eventChanges = this.ctx.storage.sql
          .exec<{ count: number }>('SELECT changes() AS count')
          .toArray()[0];
        this.ctx.storage.sql.exec(
          'DELETE FROM telemetry_trace WHERE occurred_at_ms <= ?',
          cutoffMs,
        );
        const traceChanges = this.ctx.storage.sql
          .exec<{ count: number }>('SELECT changes() AS count')
          .toArray()[0];
        if (eventChanges === undefined || traceChanges === undefined) {
          throw new TelemetryStorageError('TELEMETRY_ROW_INVALID');
        }
        const events = eventChanges.count;
        const traces = traceChanges.count;
        return events + traces;
      });
    } catch (error: unknown) {
      if (error instanceof TelemetryStorageError) throw error;
      throw new TelemetryStorageError('TELEMETRY_STORAGE_FAILURE');
    }
  }

  async alarm(): Promise<void> {
    await this.ready;
    const cutoff = new Date(Date.now() - TELEMETRY_RETENTION_MS).toISOString();
    await this.deleteExpired(cutoff);
    await this.scheduleCleanupAlarm(false);
  }
}

export type TelemetryNamespace = DurableObjectNamespace<TelemetryDO>;

export class DurableTelemetryStore implements TelemetryEventStore, TelemetryTraceStore {
  private readonly stub: TelemetryDOStub;

  constructor(namespace: TelemetryNamespace, objectName = 'telemetry-v1') {
    this.stub = namespace.getByName(objectName);
  }

  async write(record: TelemetryEventRecord | TraceRecord, ownerScopeRef: string): Promise<void> {
    const result = await ('eventId' in record
      ? this.stub.writeEvent(ownerScopeRef, record)
      : this.stub.writeTrace(ownerScopeRef, record));
    if (!result.ok) throw new TelemetryStorageError(result.code);
  }

  async readSince(cutoff: string): Promise<readonly TraceRecord[]> {
    const result = await this.stub.readTraceSince(cutoff);
    if (!result.ok) throw new TelemetryStorageError(result.code);
    return result.records;
  }

  deleteBefore(cutoff: string): Promise<number> {
    return this.stub.deleteExpired(cutoff);
  }
}

export const createDurableTelemetryStore = (
  namespace: TelemetryNamespace,
  objectName = 'telemetry-v1',
): DurableTelemetryStore => new DurableTelemetryStore(namespace, objectName);
