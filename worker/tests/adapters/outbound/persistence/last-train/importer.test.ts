import { describe, expect, it } from 'vitest';
import type { JourneyRecord, JourneyServiceDateContext } from '@ima/core';
import {
  expireJourneyDataset,
  importJourneyDataset,
  rollbackJourneyDataset,
} from '@worker/adapters/outbound/persistence/last-train/importer';
import { createJourneyReader } from '@worker/adapters/outbound/persistence/last-train/reader';
import type {
  JourneyActivationResult,
  JourneyDatasetMutationStore,
} from '@worker/adapters/outbound/persistence/last-train/store';
import {
  JourneyDatasetEnvelopeSchema,
  type JourneyDatasetEnvelope,
} from '@worker/adapters/outbound/persistence/last-train/types';
import * as v from 'valibot';

const source = {
  provider: 'fixture',
  recordRef: 'verified-table-1',
  attribution: 'Fixture import only',
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

const clone = <T>(value: T): T => structuredClone(value);

class MemoryJourneyStore implements JourneyDatasetMutationStore {
  private currentRevision: number | null = null;

  private readonly revisions = new Map<number, JourneyDatasetEnvelope>();

  readCurrent(): Promise<unknown> {
    if (this.currentRevision === null) return Promise.resolve(null);
    const dataset = this.revisions.get(this.currentRevision);
    return Promise.resolve(dataset === undefined ? null : clone(dataset));
  }

  readRevision(revision: number): Promise<unknown> {
    const dataset = this.revisions.get(revision);
    return Promise.resolve(dataset === undefined ? null : clone(dataset));
  }

  commitRevision(
    dataset: JourneyDatasetEnvelope,
    expectedRevision: number | null,
  ): Promise<JourneyActivationResult> {
    const parsed = v.safeParse(JourneyDatasetEnvelopeSchema, dataset);
    if (!parsed.success) return Promise.reject(new Error('invalid fixture dataset'));
    if (
      this.currentRevision !== expectedRevision ||
      parsed.output.revision !== (this.currentRevision ?? 0) + 1 ||
      this.revisions.has(parsed.output.revision)
    ) {
      return Promise.resolve({
        ok: false,
        code: 'REVISION_CONFLICT',
        currentRevision: this.currentRevision,
      });
    }
    this.revisions.set(parsed.output.revision, clone(parsed.output));
    this.currentRevision = parsed.output.revision;
    return Promise.resolve({ ok: true, revision: parsed.output.revision });
  }
}

describe('M14 journey dataset import and reader', () => {
  it('imports only Core-valid records and reads known data through the shared validator', async () => {
    const store = new MemoryJourneyStore();
    const imported = await importJourneyDataset(
      store,
      { records: [makeJourney('journey-1')] },
      context.now,
      null,
    );
    expect(imported).toMatchObject({ status: 'imported', revision: 1, recordCount: 1 });

    const result = await createJourneyReader(store).read(context);
    expect(result).toMatchObject({ status: 'known', revision: 1 });
    if (result.status === 'known')
      expect(result.journeys.map((item) => item.journeyRef)).toEqual(['journey-1']);
  });

  it('rejects stale or duplicate input without changing the active revision', async () => {
    const store = new MemoryJourneyStore();
    const stale = await importJourneyDataset(
      store,
      { records: [makeJourney('journey-stale', '2026-09-04T12:00:00Z')] },
      '2026-09-11T12:00:00Z',
      null,
    );
    expect(stale).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(await store.readCurrent()).toBe(null);

    const duplicate = await importJourneyDataset(
      store,
      { records: [makeJourney('journey-1'), makeJourney('journey-1')] },
      context.now,
      null,
    );
    expect(duplicate).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect(await store.readCurrent()).toBe(null);
  });

  it('uses compare-and-set revisions for update and rollback without orphaning a failed write', async () => {
    const store = new MemoryJourneyStore();
    expect(
      await importJourneyDataset(store, { records: [makeJourney('journey-1')] }, context.now, null),
    ).toMatchObject({ status: 'imported', revision: 1 });
    expect(
      await importJourneyDataset(store, { records: [makeJourney('journey-2')] }, context.now, 1),
    ).toMatchObject({ status: 'imported', revision: 2 });
    const conflict = await importJourneyDataset(
      store,
      { records: [makeJourney('journey-3')] },
      context.now,
      1,
    );
    expect(conflict).toMatchObject({ status: 'rejected', reason: 'conflict' });
    expect(await store.readRevision(3)).toBe(null);

    const rollback = await rollbackJourneyDataset(store, 1, context.now, 2);
    expect(rollback).toMatchObject({ status: 'imported', revision: 3 });
    const result = await createJourneyReader(store).read(context);
    expect(result).toMatchObject({ status: 'known', revision: 3 });
    if (result.status === 'known') expect(result.journeys[0]?.journeyRef).toBe('journey-1');
  });

  it('expires only records that cross the exclusive seven-day boundary', async () => {
    const store = new MemoryJourneyStore();
    expect(
      await importJourneyDataset(
        store,
        {
          records: [
            makeJourney('journey-old', '2026-09-04T12:00:00Z'),
            makeJourney('journey-fresh', '2026-09-05T12:00:00Z'),
          ],
        },
        context.now,
        null,
      ),
    ).toMatchObject({ status: 'imported', revision: 1 });
    const expired = await expireJourneyDataset(store, '2026-09-11T12:00:00Z');
    expect(expired).toMatchObject({ status: 'updated', revision: 2, removed: ['journey-old'] });
    const result = await createJourneyReader(store).read({
      ...context,
      now: '2026-09-11T12:00:00Z',
    });
    expect(result).toMatchObject({ status: 'known', revision: 2 });
    if (result.status === 'known') expect(result.journeys[0]?.journeyRef).toBe('journey-fresh');
  });

  it('returns disabled or not-applicable without inventing timetable data', async () => {
    const store = new MemoryJourneyStore();
    const reader = createJourneyReader(store);
    expect(await reader.read(context)).toMatchObject({ status: 'disabled' });
    expect(await reader.read({ ...context, homeStationRef: 'station-a' })).toMatchObject({
      status: 'not_applicable',
    });
  });

  it('exposes a typed storage error instead of treating a read failure as missing data', async () => {
    const failing: JourneyDatasetMutationStore = {
      readCurrent: () => Promise.reject(new Error('storage down')),
      readRevision: () => Promise.resolve(null),
      commitRevision: () => Promise.resolve({ ok: true, revision: 1 }),
    };
    expect(await createJourneyReader(failing).read(context)).toMatchObject({
      status: 'error',
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(
      await importJourneyDataset(
        failing,
        { records: [makeJourney('journey-1')] },
        context.now,
        null,
      ),
    ).toMatchObject({ status: 'rejected', reason: 'storage' });
  });
});
