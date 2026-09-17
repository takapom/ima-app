import { env, runInDurableObject } from 'cloudflare:test';
import type { JourneyRecord, JourneyServiceDateContext } from '@ima/core';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  expireJourneyDataset,
  importJourneyDataset,
  rollbackJourneyDataset,
} from '@api/providers/last-train/importer';
import { createJourneyReader } from '@api/providers/last-train/reader';
import {
  createDurableJourneyDatasetStore,
  type JourneyDatasetMutationStore,
} from '@api/providers/last-train/store';
import {
  JOURNEY_DATASET_SCHEMA_VERSION,
  JourneyDatasetEnvelopeSchema,
  parseJourneyDataset,
  type JourneyDatasetEnvelope,
} from '@api/providers/last-train/types';
import type { ThreadDO } from '@api/thread-do';

type TestEnv = Cloudflare.Env & { THREADS: DurableObjectNamespace<ThreadDO> };

const hasThreadBinding = (value: typeof env): value is TestEnv =>
  typeof value === 'object' && value !== null && 'THREADS' in value;

const testEnv = (value: typeof env): TestEnv => {
  if (!hasThreadBinding(value)) throw new Error('M14_THREAD_BINDING_MISSING');
  return value;
};

const source = {
  provider: 'fixture',
  recordRef: 'm14-worker-fixture',
  attribution: 'Worker integration fixture only',
  publicUrl: null,
};

const makeJourney = (journeyRef: string, verifiedAt = '2026-09-05T12:00:00Z'): JourneyRecord => ({
  journeyRef,
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
  serviceDate: '2026-09-10',
  servicePattern: { weekdays: ['thursday'], holidayPolicy: 'allowed' },
  lastDepartureAt: '2026-09-10T23:50:00+09:00',
  arrivesHomeAt: '2026-09-11T00:30:00+09:00',
  transfers: [],
  validFrom: '2026-09-01',
  validThrough: '2026-09-30',
  verifiedAt,
  source,
});

const context: JourneyServiceDateContext = {
  serviceDate: '2026-09-10',
  weekday: 'thursday',
  isHoliday: false,
  now: '2026-09-10T12:00:00Z',
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
};

const dataset = (
  revision: number,
  records: readonly JourneyRecord[],
  importedAt: string,
  sourceRevision: number | null,
): JourneyDatasetEnvelope =>
  v.parse(JourneyDatasetEnvelopeSchema, {
    schemaVersion: JOURNEY_DATASET_SCHEMA_VERSION,
    revision,
    importedAt,
    sourceRevision,
    records,
  });

const parsedDataset = (raw: unknown): JourneyDatasetEnvelope => {
  const parsed = parseJourneyDataset(raw);
  if (!parsed.ok) throw new Error('M14_DATASET_FIXTURE_INVALID');
  return parsed.dataset;
};

const threadStub = (threadId: string): DurableObjectStub<ThreadDO> => {
  const binding = testEnv(env).THREADS;
  return binding.getByName(threadId);
};

const initializeThread = async (threadId: string): Promise<DurableObjectStub<ThreadDO>> => {
  const stub = threadStub(threadId);
  await expect(stub.initialize(`m14-owner-${threadId}`, threadId)).resolves.toMatchObject({
    ok: true,
  });
  return stub;
};

describe('M14 Durable journey dataset storage', () => {
  it('runs import, update, rollback, expiry, and stale CAS through ThreadDO SQLite', async () => {
    const threadId = `m14-dataset-${crypto.randomUUID()}`;
    const stub = await initializeThread(threadId);
    const observed = await runInDurableObject(stub, async (_instance, state) => {
      const store = createDurableJourneyDatasetStore(state.storage);
      const first = await importJourneyDataset(
        store,
        {
          records: [
            makeJourney('journey-old', '2026-09-04T12:00:00Z'),
            makeJourney('journey-fresh'),
          ],
        },
        context.now,
        null,
      );
      const second = await importJourneyDataset(
        store,
        { records: [makeJourney('journey-updated')] },
        context.now,
        1,
      );
      const stale = await store.commitRevision(
        dataset(3, [makeJourney('journey-stale')], context.now, 2),
        1,
      );
      const afterStale = parsedDataset(await store.readCurrent());
      const rollback = await rollbackJourneyDataset(store, 1, context.now, 2);
      const history = parsedDataset(await store.readRevision(1));
      const beforeExpiry = await createJourneyReader(store).read({
        ...context,
        now: '2026-09-11T12:00:00Z',
      });
      const expired = await expireJourneyDataset(store, '2026-09-11T12:00:00Z');
      const current = parsedDataset(await store.readCurrent());
      const read = await createJourneyReader(store).read({
        ...context,
        now: '2026-09-11T12:00:00Z',
      });
      const revisionRows = state.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM m14_last_train_dataset')
        .toArray()[0]?.count;
      return {
        first,
        second,
        stale,
        afterStale,
        rollback,
        history,
        beforeExpiry,
        expired,
        current,
        read,
        revisionRows,
      };
    });

    expect(observed.first).toMatchObject({ status: 'imported', revision: 1, recordCount: 2 });
    expect(observed.second).toMatchObject({ status: 'imported', revision: 2, recordCount: 1 });
    expect(observed.stale).toEqual({ ok: false, code: 'REVISION_CONFLICT', currentRevision: 2 });
    expect(observed.afterStale.revision).toBe(2);
    expect(observed.rollback).toMatchObject({ status: 'imported', revision: 3, recordCount: 2 });
    expect(observed.history.revision).toBe(1);
    expect(observed.beforeExpiry).toMatchObject({ status: 'known', revision: 3 });
    if (observed.beforeExpiry.status === 'known') {
      expect(observed.beforeExpiry.journeys.map((journey) => journey.journeyRef)).toEqual([
        'journey-fresh',
      ]);
    }
    expect(observed.expired).toMatchObject({
      status: 'updated',
      revision: 4,
      removed: ['journey-old'],
    });
    expect(observed.current.records.map((record) => record.journeyRef)).toEqual(['journey-fresh']);
    expect(observed.revisionRows).toBe(4);
    expect(observed.read).toMatchObject({ status: 'known', revision: 4 });
    if (observed.read.status === 'known') {
      expect(observed.read.journeys.map((journey) => journey.journeyRef)).toEqual([
        'journey-fresh',
      ]);
    }
  });

  it('rolls back an interrupted transaction without publishing a partial active dataset', async () => {
    const threadId = `m14-dataset-atomic-${crypto.randomUUID()}`;
    const stub = await initializeThread(threadId);
    const observed = await runInDurableObject(stub, async (_instance, state) => {
      const store: JourneyDatasetMutationStore = createDurableJourneyDatasetStore(state.storage);
      const candidate = dataset(1, [makeJourney('journey-atomic')], context.now, null);
      state.storage.sql.exec('DELETE FROM m14_last_train_state');
      let errorCode: string | null = null;
      try {
        await store.commitRevision(candidate, null);
      } catch (error: unknown) {
        errorCode = error instanceof Error && 'code' in error ? String(error.code) : null;
      }
      const rows = state.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM m14_last_train_dataset')
        .toArray()[0]?.count;
      return { errorCode, rows, current: await store.readCurrent() };
    });

    expect(observed.errorCode).toBe('WRITE_FAILED');
    expect(observed.rows).toBe(0);
    expect(observed.current).toBe(null);
  });
});
