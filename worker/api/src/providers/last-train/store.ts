import * as v from 'valibot';
import {
  JourneyDatasetEnvelopeSchema,
  type JourneyDatasetEnvelope,
} from '@api/providers/last-train/types';

export type JourneyDatasetReader = {
  readonly readCurrent: () => Promise<unknown>;
  readonly readRevision: (revision: number) => Promise<unknown>;
};

export type JourneyActivationResult =
  | { readonly ok: true; readonly revision: number }
  | {
      readonly ok: false;
      readonly code: 'REVISION_CONFLICT' | 'REVISION_NOT_FOUND';
      readonly currentRevision: number | null;
    };

export type JourneyDatasetStorageErrorCode = 'READ_FAILED' | 'WRITE_FAILED' | 'INVALID_DATASET';

export class JourneyDatasetStorageError extends Error {
  readonly code: JourneyDatasetStorageErrorCode;

  constructor(code: JourneyDatasetStorageErrorCode) {
    super(`journey dataset storage failed: ${code}`);
    this.name = 'JourneyDatasetStorageError';
    this.code = code;
  }
}

export type JourneyDatasetMutationStore = JourneyDatasetReader & {
  /** The DO-backed implementation stages and activates in one transaction. */
  readonly commitRevision: (
    dataset: JourneyDatasetEnvelope,
    expectedRevision: number | null,
  ) => Promise<JourneyActivationResult>;
};

export const JOURNEY_DATASET_CURRENT_KEY = 'm14/last-train/current';
export const JOURNEY_DATASET_REVISION_PREFIX = 'm14/last-train/revision/';

/**
 * KV is a read boundary here. Mutations require a DO or another atomic
 * implementation of JourneyDatasetMutationStore; a read-then-write KV helper
 * would make rollback and CAS claims false.
 */
export const createKvJourneyDatasetReader = (
  kv: Pick<KVNamespace, 'get'>,
): JourneyDatasetReader => ({
  readCurrent: async () => {
    try {
      return await kv.get(JOURNEY_DATASET_CURRENT_KEY, { type: 'json' });
    } catch {
      throw new JourneyDatasetStorageError('READ_FAILED');
    }
  },
  readRevision: async (revision) => {
    try {
      return await kv.get(`${JOURNEY_DATASET_REVISION_PREFIX}${revision}`, { type: 'json' });
    } catch {
      throw new JourneyDatasetStorageError('READ_FAILED');
    }
  },
});

type DatasetRow = { readonly revision: number; readonly payload: string };
type DatasetStateRow = { readonly singleton: number; readonly current_revision: number | null };

export const initializeDurableJourneyDataset = (storage: DurableObjectStorage): void => {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS m14_last_train_dataset (
      revision INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    )
  `);
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS m14_last_train_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      current_revision INTEGER
    )
  `);
  storage.sql.exec(
    'INSERT OR IGNORE INTO m14_last_train_state (singleton, current_revision) VALUES (1, NULL)',
  );
};

const payloadFrom = (storage: DurableObjectStorage, revision: number): unknown => {
  const row = storage.sql
    .exec<DatasetRow>(
      'SELECT revision, payload FROM m14_last_train_dataset WHERE revision = ?',
      revision,
    )
    .toArray()[0];
  if (row === undefined) return null;
  try {
    return JSON.parse(row.payload) as unknown;
  } catch {
    throw new JourneyDatasetStorageError('READ_FAILED');
  }
};

/** Atomic revision storage for a ThreadDO or another Durable Object owner. */
export const createDurableJourneyDatasetStore = (
  storage: DurableObjectStorage,
): JourneyDatasetMutationStore => {
  initializeDurableJourneyDataset(storage);
  return {
    readCurrent() {
      try {
        const state = storage.sql
          .exec<DatasetStateRow>(
            'SELECT singleton, current_revision FROM m14_last_train_state WHERE singleton = 1',
          )
          .toArray()[0];
        return Promise.resolve(
          state?.current_revision === null || state === undefined
            ? null
            : payloadFrom(storage, state.current_revision),
        );
      } catch (error: unknown) {
        return Promise.reject(
          error instanceof JourneyDatasetStorageError
            ? error
            : new JourneyDatasetStorageError('READ_FAILED'),
        );
      }
    },
    readRevision(revision) {
      try {
        return Promise.resolve(payloadFrom(storage, revision));
      } catch (error: unknown) {
        return Promise.reject(
          error instanceof JourneyDatasetStorageError
            ? error
            : new JourneyDatasetStorageError('READ_FAILED'),
        );
      }
    },
    commitRevision(dataset, expectedRevision) {
      const parsed = v.safeParse(JourneyDatasetEnvelopeSchema, dataset);
      if (!parsed.success) return Promise.reject(new JourneyDatasetStorageError('INVALID_DATASET'));
      try {
        return Promise.resolve(
          storage.transactionSync(() => {
            const state = storage.sql
              .exec<DatasetStateRow>(
                'SELECT singleton, current_revision FROM m14_last_train_state WHERE singleton = 1',
              )
              .toArray()[0];
            const currentRevision = state?.current_revision ?? null;
            if (currentRevision !== expectedRevision) {
              return { ok: false, code: 'REVISION_CONFLICT', currentRevision } as const;
            }
            if (parsed.output.revision !== (currentRevision ?? 0) + 1) {
              return { ok: false, code: 'REVISION_CONFLICT', currentRevision } as const;
            }
            const existing = storage.sql
              .exec<DatasetRow>(
                'SELECT revision, payload FROM m14_last_train_dataset WHERE revision = ?',
                parsed.output.revision,
              )
              .toArray()[0];
            if (existing !== undefined) {
              return { ok: false, code: 'REVISION_CONFLICT', currentRevision } as const;
            }
            storage.sql.exec(
              'INSERT INTO m14_last_train_dataset (revision, payload) VALUES (?, ?)',
              parsed.output.revision,
              JSON.stringify(parsed.output),
            );
            const stateUpdate =
              expectedRevision === null
                ? storage.sql.exec(
                    'UPDATE m14_last_train_state SET current_revision = ? WHERE singleton = 1 AND current_revision IS NULL',
                    parsed.output.revision,
                  )
                : storage.sql.exec(
                    'UPDATE m14_last_train_state SET current_revision = ? WHERE singleton = 1 AND current_revision = ?',
                    parsed.output.revision,
                    expectedRevision,
                  );
            if (stateUpdate.rowsWritten !== 1) {
              throw new JourneyDatasetStorageError('WRITE_FAILED');
            }
            return { ok: true, revision: parsed.output.revision } as const;
          }),
        );
      } catch (error: unknown) {
        return Promise.reject(
          error instanceof JourneyDatasetStorageError
            ? error
            : new JourneyDatasetStorageError('WRITE_FAILED'),
        );
      }
    },
  };
};
