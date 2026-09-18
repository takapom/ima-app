import { env, runInDurableObject, SELF } from 'cloudflare:test';
import type { JourneyRecord, JourneyServiceDateContext } from '@ima/core';
import { describe, expect, it } from 'vitest';
import {
  handleJourneyDatasetManagement,
  JOURNEY_DATASET_ADMIN_HEADER,
  JOURNEY_DATASET_MANAGEMENT_PATH,
} from '@worker/infrastructure/adapters/inbound/http/journey-dataset-management';
import {
  JOURNEY_DATASET_DO_NAME,
  type JourneyDatasetDO,
} from '@worker/infrastructure/adapters/outbound/persistence/last-train/dataset-do';

const ADMIN_TOKEN = 'm14-admin-fixture-token';
// Keep the original relative dates while placing expiry alarms after the real test clock.
const fixtureOffset = Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse('2026-09-10');
const fixtureDate = (value: string): string => {
  const shifted = new Date(Date.parse(value) + fixtureOffset).toISOString();
  return value.length === 10 ? shifted.slice(0, 10) : shifted;
};
const weekdays = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
const weekday = weekdays[new Date().getUTCDay()] ?? 'thursday';
const NOW = fixtureDate('2026-09-10T12:00:00Z');

type TestEnv = Cloudflare.Env & {
  JOURNEY_DATASETS: DurableObjectNamespace<JourneyDatasetDO>;
};

type JsonRecord = Record<string, unknown>;

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasDatasetBinding = (value: typeof env): value is TestEnv =>
  typeof value === 'object' && value !== null && 'JOURNEY_DATASETS' in value;

const testEnv = (value: typeof env): TestEnv => {
  if (!hasDatasetBinding(value)) throw new Error('M14_JOURNEY_DATASET_BINDING_MISSING');
  return value;
};

const journey = (
  journeyRef: string,
  verifiedAt = fixtureDate('2026-09-05T12:00:00Z'),
): JourneyRecord => ({
  journeyRef,
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
  serviceDate: fixtureDate('2026-09-10'),
  servicePattern: { weekdays: [weekday], holidayPolicy: 'allowed' },
  lastDepartureAt: fixtureDate('2026-09-10T23:50:00+09:00'),
  arrivesHomeAt: fixtureDate('2026-09-11T00:30:00+09:00'),
  transfers: [],
  validFrom: fixtureDate('2026-09-01'),
  validThrough: fixtureDate('2026-09-30'),
  verifiedAt,
  source: {
    provider: 'fixture',
    recordRef: 'm14-management-fixture',
    attribution: 'Worker integration fixture only',
    publicUrl: null,
  },
});

const context: JourneyServiceDateContext = {
  serviceDate: fixtureDate('2026-09-10'),
  weekday,
  isHoliday: false,
  now: NOW,
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
};

const requestFor = (body: unknown, token = ADMIN_TOKEN): Request =>
  new Request(`https://ima.test${JOURNEY_DATASET_MANAGEMENT_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [JOURNEY_DATASET_ADMIN_HEADER]: token,
    },
    body: JSON.stringify(body),
  });

const json = async (response: Response): Promise<JsonRecord> => {
  const value: unknown = await response.json();
  if (!isJsonRecord(value)) throw new Error('M14_EXPECTED_JSON_OBJECT');
  return value;
};

const call = async (body: unknown, now = NOW, token = ADMIN_TOKEN): Promise<Response> => {
  const binding = testEnv(env).JOURNEY_DATASETS;
  const response = await handleJourneyDatasetManagement(requestFor(body, token), {
    namespace: binding,
    adminToken: ADMIN_TOKEN,
    clock: () => now,
  });
  if (response === null) throw new Error('M14_MANAGEMENT_ROUTE_NOT_MATCHED');
  return response;
};

describe('M14 shared journey dataset management boundary', () => {
  it('uses one named DO RPC for import/update/rollback/expiry with server time', async () => {
    const firstStub = testEnv(env).JOURNEY_DATASETS.getByName(JOURNEY_DATASET_DO_NAME);
    await expect(firstStub.readRevision()).resolves.toBeNull();

    const imported = await call({
      kind: 'import',
      records: [journey('journey-one', fixtureDate('2026-09-04T12:00:00Z'))],
      expectedRevision: null,
    });
    expect(imported.status).toBe(200);
    expect((await json(imported)).result).toMatchObject({
      status: 'imported',
      revision: 1,
    });
    await expect(firstStub.readRevision()).resolves.toBe(1);
    await expect(
      runInDurableObject(firstStub, async (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBe(Date.parse(fixtureDate('2026-09-11T12:00:00Z')));

    const updated = await call({
      kind: 'update',
      records: [journey('journey-two')],
      expectedRevision: 1,
    });
    expect(updated.status).toBe(200);
    expect((await json(updated)).result).toMatchObject({ status: 'imported', revision: 2 });
    await expect(
      runInDurableObject(firstStub, async (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBe(Date.parse(fixtureDate('2026-09-12T12:00:00Z')));

    const stale = await call({
      kind: 'update',
      records: [journey('journey-stale')],
      expectedRevision: 1,
    });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({
      status: 'error',
      result: { status: 'rejected', reason: 'conflict' },
    });

    const rolledBack = await call({
      kind: 'rollback',
      targetRevision: 1,
      expectedRevision: 2,
    });
    expect(rolledBack.status).toBe(200);
    expect((await json(rolledBack)).result).toMatchObject({ status: 'imported', revision: 3 });
    await expect(firstStub.readRevision()).resolves.toBe(3);

    const stub = testEnv(env).JOURNEY_DATASETS.getByName(JOURNEY_DATASET_DO_NAME);
    await expect(
      runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBe(Date.parse(fixtureDate('2026-09-11T12:00:00Z')));

    const alarmFailure = await runInDurableObject(stub, async (instance) => {
      Object.defineProperty(instance, 'synchronizeAlarm', {
        configurable: true,
        value: () => Promise.reject(new Error('M14_ALARM_FIXTURE_FAILURE')),
      });
      try {
        return await instance.execute(
          {
            kind: 'update',
            records: [journey('journey-alarm-failure')],
            expectedRevision: 3,
          },
          NOW,
        );
      } finally {
        delete (
          instance as unknown as { synchronizeAlarm?: (alarmAt: number | null) => Promise<void> }
        ).synchronizeAlarm;
      }
    });
    expect(alarmFailure).toMatchObject({
      status: 'alarm_failed',
      commandStatus: 'imported',
      revision: 4,
    });
    const unchanged = await call({ kind: 'expire' }, NOW);
    expect(unchanged.status).toBe(200);
    expect((await json(unchanged)).result).toMatchObject({ status: 'unchanged', revision: 4 });

    const alarmResult = await runInDurableObject(stub, async (instance, state) => {
      Object.defineProperty(instance, 'serverNow', {
        configurable: true,
        value: () => fixtureDate('2026-09-12T12:00:00Z'),
      });
      try {
        await instance.alarm();
        return {
          current: await state.storage.getAlarm(),
          read: await instance.read({ ...context, now: fixtureDate('2026-09-12T12:00:00Z') }),
        };
      } finally {
        delete (instance as unknown as { serverNow?: () => string }).serverNow;
      }
    });
    expect(alarmResult.current).toBeNull();
    expect(alarmResult.read).toMatchObject({ status: 'disabled', revision: 5 });

    await expect(stub.read(context)).resolves.toMatchObject({ status: 'disabled', revision: 5 });
  });

  it('executes a successful command through the real Worker entrypoint and named DO RPC', async () => {
    const stub = testEnv(env).JOURNEY_DATASETS.getByName(JOURNEY_DATASET_DO_NAME);
    const current = await stub.read(context);
    const expectedRevision = current.status === 'error' ? null : current.revision;
    const response = await SELF.fetch(
      requestFor({
        kind: expectedRevision === null ? 'import' : 'update',
        records: [journey('journey-self-fetch')],
        expectedRevision,
      }),
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      schemaVersion: 'v1',
      status: 'ok',
      result: { status: 'imported', recordCount: 1 },
    });
    await expect(stub.read(context)).resolves.toMatchObject({
      status: 'known',
      journeys: [{ journeyRef: 'journey-self-fetch' }],
    });
  });

  it('keeps an inclusive validThrough cross-midnight journey in the Core service-date read', async () => {
    const stub = testEnv(env).JOURNEY_DATASETS.getByName(JOURNEY_DATASET_DO_NAME);
    const crossMidnight = {
      ...journey('journey-cross-midnight'),
      validThrough: fixtureDate('2026-09-10'),
    };
    const current = await stub.read(context);
    const expectedRevision = current.status === 'error' ? null : current.revision;
    const imported = await call({
      kind: expectedRevision === null ? 'import' : 'update',
      records: [crossMidnight],
      expectedRevision,
    });
    expect(imported.status).toBe(200);
    const importedBody = await json(imported);
    expect(importedBody.result).toMatchObject({
      status: 'imported',
      revision: typeof expectedRevision === 'number' ? expectedRevision + 1 : 1,
    });
    const revision = typeof expectedRevision === 'number' ? expectedRevision + 1 : 1;
    await expect(
      runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBe(Date.parse(fixtureDate('2026-09-12T12:00:00Z')));
    await expect(
      stub.read({ ...context, now: fixtureDate('2026-09-10T15:29:59Z') }),
    ).resolves.toMatchObject({
      status: 'known',
      revision,
    });
    await expect(
      stub.read({ ...context, now: fixtureDate('2026-09-10T15:30:01Z') }),
    ).resolves.toMatchObject({
      status: 'known',
      revision,
    });
  });

  it('keeps the maintenance path separate from public authentication and rejects extra clock input', async () => {
    expect(await call({ kind: 'expire' }, NOW, 'wrong-token')).toMatchObject({ status: 401 });
    await expect(SELF.fetch(requestFor({ kind: 'expire' }, 'wrong-token'))).resolves.toMatchObject({
      status: 401,
    });
    const extraClock = await call({
      kind: 'expire',
      now: '2000-01-01T00:00:00Z',
    });
    expect(extraClock.status).toBe(400);

    const nonManagement = await handleJourneyDatasetManagement(
      new Request('https://ima.test/v1/search', { method: 'POST' }),
      { namespace: testEnv(env).JOURNEY_DATASETS, adminToken: ADMIN_TOKEN, clock: () => NOW },
    );
    expect(nonManagement).toBeNull();
  });

  it('bounds a streamed body even when Content-Length is absent', async () => {
    const oversizedBody = JSON.stringify({ kind: 'expire', padding: 'x'.repeat(512 * 1024) });
    const response = await handleJourneyDatasetManagement(
      new Request(`https://ima.test${JOURNEY_DATASET_MANAGEMENT_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [JOURNEY_DATASET_ADMIN_HEADER]: ADMIN_TOKEN,
        },
        body: oversizedBody,
      }),
      {
        namespace: testEnv(env).JOURNEY_DATASETS,
        adminToken: ADMIN_TOKEN,
        clock: () => NOW,
      },
    );
    if (response === null) throw new Error('M14_MANAGEMENT_ROUTE_NOT_MATCHED');
    expect(response.status).toBe(413);
  });
});
