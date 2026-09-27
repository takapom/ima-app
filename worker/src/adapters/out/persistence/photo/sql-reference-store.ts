import type { Lifecycle } from 'agents/lifecycle';
import { createThreadPhotoReferences } from '@worker/adapters/out/persistence/photo/thread-references';
import { createMemoryPhotoReferenceStore } from '@worker/adapters/out/persistence/photo/reference-store';
import * as v from 'valibot';
import {
  PhotoReferenceRecordSchema,
  PhotoTokenError,
  type PhotoReferenceStoreWithClear,
} from '@worker/runtime/ports/photo';

/** Only signed-handle mappings are durable. Image bytes never enter SQLite. */
export const createSqlPhotoReferenceStore = (
  storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>,
) => {
  const transient = createMemoryPhotoReferenceStore();
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS photo_references (handle TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at REAL NOT NULL)',
  );
  storage.sql.exec(
    'CREATE INDEX IF NOT EXISTS photo_reference_expiry ON photo_references (expires_at)',
  );
  const purge = (now: string) => {
    storage.sql.exec('DELETE FROM photo_references WHERE expires_at <= ?', Date.parse(now));
  };
  const store: PhotoReferenceStoreWithClear = {
    put(input, requestedNow = new Date().toISOString()) {
      if (input.persist !== true) return transient.put(input, requestedNow);
      return Promise.resolve().then(() => {
        const parsed = v.safeParse(PhotoReferenceRecordSchema, input);
        const now = Date.parse(requestedNow);
        if (
          !parsed.success ||
          !Number.isFinite(now) ||
          Date.parse(parsed.output.expiresAt) <= now ||
          Date.parse(parsed.output.expiresAt) > now + 30 * 60 * 1000
        )
          throw new PhotoTokenError('INVALID_INPUT');
        storage.transactionSync(() => {
          purge(requestedNow);
          if (
            storage.sql
              .exec('SELECT handle FROM photo_references WHERE handle = ?', parsed.output.handle)
              .toArray().length > 0
          )
            throw new PhotoTokenError('REFERENCE_CONFLICT');
          storage.sql.exec(
            'INSERT INTO photo_references VALUES (?, ?, ?)',
            parsed.output.handle,
            JSON.stringify(parsed.output),
            Date.parse(parsed.output.expiresAt),
          );
        });
      });
    },
    get(handle, now, scope) {
      return Promise.resolve().then(() => {
        if (!Number.isFinite(Date.parse(now))) throw new PhotoTokenError('INVALID_INPUT');
        purge(now);
        const row = storage.sql
          .exec<{ body: string }>('SELECT body FROM photo_references WHERE handle = ?', handle)
          .toArray()[0];
        if (row === undefined) return transient.get(handle, now, scope);
        const record = v.parse(PhotoReferenceRecordSchema, JSON.parse(row.body));
        return scope !== undefined &&
          (record.ownerScopeRef !== scope.ownerScopeRef ||
            record.deviceIdHash !== scope.deviceIdHash)
          ? undefined
          : record;
      });
    },
    clear() {
      storage.sql.exec('DELETE FROM photo_references');
      return transient.clear();
    },
  };
  return {
    ...store,
    purge,
    nextAlarm: () =>
      storage.sql
        .exec<{ deadline: number | null }>(
          'SELECT MIN(expires_at) AS deadline FROM photo_references',
        )
        .toArray()[0]?.deadline ?? null,
  };
};

/** Compose lifetime management with the owner/device authorization wrapper. */
export const createPersistentThreadPhotoReferences = (
  storage: DurableObjectStorage,
  lifecycle: Pick<Lifecycle, 'use' | 'rearmAlarm'>,
  options: Parameters<typeof createThreadPhotoReferences>[0] & { readonly clock: () => string },
) => {
  const store = createSqlPhotoReferenceStore(storage);
  lifecycle.use({ getNextAlarm: store.nextAlarm, onAlarm: () => store.purge(options.clock()) });
  const references = createThreadPhotoReferences({ ...options, store });
  return {
    ...references,
    async putPhotoReference(...args: Parameters<typeof references.putPhotoReference>) {
      const result = await references.putPhotoReference(...args);
      await lifecycle.rearmAlarm();
      return result;
    },
  };
};
