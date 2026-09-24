import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TelemetryDO } from '@worker/adapters/out/persistence/telemetry/telemetry-do';
import { TELEMETRY_RETENTION_MS } from '@worker/telemetry/retention';

const OWNER_A = 'A'.repeat(42) + 'E';
const OWNER_B = 'B'.repeat(42) + 'E';

type TestEnv = Cloudflare.Env & {
  TELEMETRY: DurableObjectNamespace<TelemetryDO>;
};

const hasTelemetryBinding = (value: typeof env): value is TestEnv =>
  typeof value === 'object' && value !== null && 'TELEMETRY' in value;

const testEnv = (value: typeof env): TestEnv => {
  if (!hasTelemetryBinding(value)) throw new Error('M26_TELEMETRY_BINDING_MISSING');
  return value;
};

const now = (): string => new Date(Date.now() - 1_000).toISOString();

const event = (eventId: string, occurredAt = now()) => ({
  eventId,
  threadId: `thread-${eventId}`,
  name: 'search_failed' as const,
  occurredAt,
  status: 'error' as const,
  code: 'PROVIDER_TIMEOUT' as const,
});

const trace = (traceId: string, occurredAt = now()) => ({
  schemaVersion: 'v1' as const,
  traceId,
  threadId: `thread-${traceId}`,
  turnId: `turn-${traceId}`,
  occurredAt,
  operation: 'provider' as const,
  provider: 'places' as const,
  status: 'ok' as const,
  durationMs: 50,
});

describe('M26 telemetry Durable Object', () => {
  it('deduplicates equal event IDs per owner and rejects changed payloads', async () => {
    const stub = testEnv(env).TELEMETRY.getByName(`telemetry-event-${crypto.randomUUID()}`);
    const record = event(`event-${crypto.randomUUID()}`);
    await expect(stub.writeEvent(OWNER_A, record)).resolves.toEqual({ ok: true });
    await expect(stub.writeEvent(OWNER_A, record)).resolves.toEqual({ ok: true });
    await expect(stub.writeEvent(OWNER_B, record)).resolves.toEqual({ ok: true });
    await expect(stub.writeEvent(OWNER_A, { ...record, status: 'partial' })).resolves.toEqual({
      ok: false,
      code: 'TELEMETRY_EVENT_CONFLICT',
    });
  });

  it('rejects future and expired client timestamps', async () => {
    const stub = testEnv(env).TELEMETRY.getByName(`telemetry-window-${crypto.randomUUID()}`);
    await expect(
      stub.writeEvent(
        OWNER_A,
        event(`future-${crypto.randomUUID()}`, new Date(Date.now() + 1_000).toISOString()),
      ),
    ).resolves.toEqual({ ok: false, code: 'TELEMETRY_RECORD_FUTURE' });
    await expect(
      stub.writeEvent(
        OWNER_A,
        event(
          `expired-${crypto.randomUUID()}`,
          new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
        ),
      ),
    ).resolves.toEqual({ ok: false, code: 'TELEMETRY_RECORD_EXPIRED' });
    await expect(
      stub.writeTrace(
        OWNER_A,
        trace(
          `boundary-${crypto.randomUUID()}`,
          new Date(Date.now() - TELEMETRY_RETENTION_MS).toISOString(),
        ),
      ),
    ).resolves.toEqual({ ok: false, code: 'TELEMETRY_RECORD_EXPIRED' });
  });

  it('stores traces and deletes both tables at the explicit retention boundary', async () => {
    const stub = testEnv(env).TELEMETRY.getByName(`telemetry-cleanup-${crypto.randomUUID()}`);
    await stub.writeEvent(OWNER_A, event(`event-${crypto.randomUUID()}`));
    await stub.writeTrace(OWNER_A, trace(`trace-${crypto.randomUUID()}`));
    const deleted = await stub.deleteExpired(new Date(Date.now()).toISOString());
    expect(deleted).toBe(2);
    await expect(stub.readTraceSince(new Date(0).toISOString())).resolves.toEqual({
      ok: true,
      records: [],
    });
  });

  it('orders offset timestamps by epoch and clamps reads to seven days', async () => {
    const stub = testEnv(env).TELEMETRY.getByName(`telemetry-time-${crypto.randomUUID()}`);
    const epoch = Date.now() - 2_000;
    const utc = new Date(epoch).toISOString();
    const offset = new Date(epoch + 9 * 60 * 60 * 1_000).toISOString().replace('Z', '+09:00');
    const utcTrace = trace(`trace-utc-${crypto.randomUUID()}`, utc);
    const offsetTrace = trace(`trace-offset-${crypto.randomUUID()}`, offset);
    await expect(stub.writeTrace(OWNER_A, utcTrace)).resolves.toEqual({ ok: true });
    await expect(stub.writeTrace(OWNER_A, offsetTrace)).resolves.toEqual({ ok: true });
    const oldTrace = trace(
      `trace-old-${crypto.randomUUID()}`,
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
    );
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO telemetry_trace (owner_scope_ref, trace_id, occurred_at_ms, payload_json) VALUES (?, ?, ?, ?)',
        OWNER_A,
        oldTrace.traceId,
        Date.parse(oldTrace.occurredAt),
        JSON.stringify(oldTrace),
      );
    });

    const read = await stub.readTraceSince(new Date(0).toISOString());
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('M26_TRACE_READ_FAILED');
    expect(read.records.map((record) => record.traceId)).toEqual(
      expect.arrayContaining([utcTrace.traceId, offsetTrace.traceId]),
    );
    expect(read.records.map((record) => record.traceId)).not.toContain(oldTrace.traceId);
  });

  it('advances the alarm for backdated writes and expires the exact boundary', async () => {
    const stub = testEnv(env).TELEMETRY.getByName(`telemetry-alarm-${crypto.randomUUID()}`);
    const before = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    if (before === null) throw new Error('M26_ALARM_NOT_INITIALIZED');
    const backdatedAt = new Date(Date.now() - TELEMETRY_RETENTION_MS + 60_000).toISOString();
    await expect(
      stub.writeEvent(OWNER_A, event(`backdated-${crypto.randomUUID()}`, backdatedAt)),
    ).resolves.toEqual({
      ok: true,
    });
    const after = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    if (after === null) throw new Error('M26_ALARM_NOT_SCHEDULED');
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThanOrEqual(Date.parse(backdatedAt) + TELEMETRY_RETENTION_MS);

    const boundaryAt = new Date(Date.now() - TELEMETRY_RETENTION_MS).toISOString();
    const boundaryTrace = trace(`boundary-trace-${crypto.randomUUID()}`, boundaryAt);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO telemetry_trace (owner_scope_ref, trace_id, occurred_at_ms, payload_json) VALUES (?, ?, ?, ?)',
        OWNER_A,
        boundaryTrace.traceId,
        Date.parse(boundaryTrace.occurredAt),
        JSON.stringify(boundaryTrace),
      );
    });
    const read = await stub.readTraceSince(new Date(0).toISOString());
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('M26_TRACE_READ_FAILED');
    expect(read.records.map((record) => record.traceId)).not.toContain(boundaryTrace.traceId);
    await expect(stub.deleteExpired(boundaryAt)).resolves.toBe(1);
  });

  it('skips rows of a retired provider instead of failing the whole read', async () => {
    const stub = testEnv(env).TELEMETRY.getByName(`telemetry-retired-${crypto.randomUUID()}`);
    const current = trace(`trace-current-${crypto.randomUUID()}`);
    const retired = { ...trace(`trace-retired-${crypto.randomUUID()}`), provider: 'last_train' };
    await expect(stub.writeTrace(OWNER_A, current)).resolves.toEqual({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO telemetry_trace (owner_scope_ref, trace_id, occurred_at_ms, payload_json) VALUES (?, ?, ?, ?)',
        OWNER_A,
        retired.traceId,
        Date.parse(retired.occurredAt),
        JSON.stringify(retired),
      );
    });
    const read = await stub.readTraceSince(new Date(0).toISOString());
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('M26_TRACE_READ_FAILED');
    expect(read.records.map((record) => record.traceId)).toEqual([current.traceId]);
  });

  it('classifies corrupt stored JSON without exposing parser details', async () => {
    const stub = testEnv(env).TELEMETRY.getByName(`telemetry-corrupt-${crypto.randomUUID()}`);
    const record = trace(`trace-corrupt-${crypto.randomUUID()}`);
    await expect(stub.writeTrace(OWNER_A, record)).resolves.toEqual({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE telemetry_trace SET payload_json = ? WHERE owner_scope_ref = ? AND trace_id = ?',
        '{"broken":',
        OWNER_A,
        record.traceId,
      );
    });
    await expect(stub.readTraceSince(new Date(0).toISOString())).resolves.toEqual({
      ok: false,
      code: 'TELEMETRY_ROW_INVALID',
    });
  });

  it('connects POST /v1/events to the singleton SQLite store', async () => {
    const eventId = `http-event-${crypto.randomUUID()}`;
    const threadId = `http-thread-${crypto.randomUUID()}`;
    const requestId = `http-request-${crypto.randomUUID()}`;
    const headers = {
      'content-type': 'application/json',
      'x-app-token': 'test-app-token',
      'x-device-id': `device-${crypto.randomUUID()}`,
      'x-ima-owner-credential': OWNER_A,
      'x-ima-request-id': requestId,
      'x-app-version': 'm26-test',
    };
    const created = await SELF.fetch('https://ima.test/v1/threads', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId,
        idempotencyKey: `create-${threadId}`,
      }),
    });
    expect(created.status).toBe(201);
    const createdBody: unknown = await created.json();
    if (
      typeof createdBody !== 'object' ||
      createdBody === null ||
      !('threadId' in createdBody) ||
      typeof createdBody.threadId !== 'string'
    ) {
      throw new Error('M26_THREAD_CREATE_FAILED');
    }
    const response = await SELF.fetch('https://ima.test/v1/events', {
      method: 'POST',
      headers: { ...headers, 'x-ima-request-id': `event-${requestId}` },
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId: `event-${requestId}`,
        threadId: createdBody.threadId,
        event: {
          eventId,
          name: 'search_failed',
          occurredAt: now(),
          status: 'error',
          code: 'PROVIDER_TIMEOUT',
        },
      }),
    });
    expect(response.status).toBe(204);
    const telemetry = testEnv(env).TELEMETRY.getByName('telemetry-v1');
    const count = await runInDurableObject(
      telemetry,
      (_instance, state) =>
        state.storage.sql
          .exec<{ readonly count: number }>(
            'SELECT COUNT(*) AS count FROM telemetry_event WHERE event_id = ?',
            eventId,
          )
          .toArray()[0]?.count,
    );
    expect(count).toBe(1);
  });
});
