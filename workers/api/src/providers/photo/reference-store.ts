import * as v from 'valibot';
import { IsoTimestampSchema } from '@ima/contracts';
import {
  PhotoReferenceRecordSchema,
  PhotoTokenError,
  type PhotoReferenceRecord,
  type PhotoReferenceStore,
} from './types';

const DEFAULT_MAX_ENTRIES = 256;

const parseClock = (value: string): number => {
  const parsed = v.safeParse(IsoTimestampSchema, value);
  const milliseconds = parsed.success ? Date.parse(parsed.output) : Number.NaN;
  if (!Number.isFinite(milliseconds)) throw new PhotoTokenError('INVALID_INPUT');
  return milliseconds;
};

/**
 * A deliberately non-global reference store for a ThreadDO/runtime instance.
 * Eviction is equivalent to provider-name expiry from the public API's point
 * of view: the caller receives no photo reference and must re-fetch details.
 */
export const createMemoryPhotoReferenceStore = (
  options: {
    readonly maxEntries?: number;
  } = {},
): PhotoReferenceStore => {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new PhotoTokenError('INVALID_INPUT');
  }
  const entries = new Map<string, PhotoReferenceRecord>();

  const purge = (nowMilliseconds: number): void => {
    for (const [handle, record] of entries) {
      if (Date.parse(record.expiresAt) <= nowMilliseconds) entries.delete(handle);
    }
  };

  return {
    put(record: PhotoReferenceRecord): Promise<void> {
      return Promise.resolve().then(() => {
        const parsed = v.safeParse(PhotoReferenceRecordSchema, record);
        if (!parsed.success) throw new PhotoTokenError('INVALID_INPUT');
        if (entries.has(parsed.output.handle)) {
          throw new PhotoTokenError('REFERENCE_CONFLICT');
        }
        while (entries.size >= maxEntries) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          entries.delete(oldest);
        }
        entries.set(parsed.output.handle, parsed.output);
      });
    },

    get(handle: string, now: string): Promise<PhotoReferenceRecord | undefined> {
      return Promise.resolve().then(() => {
        const nowMilliseconds = parseClock(now);
        purge(nowMilliseconds);
        return entries.get(handle);
      });
    },
  };
};
