import * as v from 'valibot';
import { IsoTimestampSchema, OpaqueIdSchema } from '@ima/contracts';
import { createMemoryPhotoReferenceStore } from '@api/providers/photo/reference-store';
import type { PhotoReferenceGetResult, PhotoReferencePutResult } from '@api/providers/photo/rpc';
import {
  PhotoReferenceRecordSchema,
  PhotoTokenError,
  type PhotoReferenceRecord,
  type PhotoReferenceStoreWithClear,
} from '@api/providers/photo/types';

const MAX_TTL_MILLISECONDS = 30 * 60 * 1_000;
const HandleSchema = v.pipe(v.string(), v.length(22));
const OwnerScopeSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(160));

export type ThreadPhotoReferences = {
  putPhotoReference(
    ownerScopeRef: string,
    record: PhotoReferenceRecord,
    requestedNow: string,
  ): Promise<PhotoReferencePutResult>;
  getPhotoReference(
    ownerScopeRef: string,
    handle: string,
    deviceIdHash: string,
    requestedNow: string,
  ): Promise<PhotoReferenceGetResult>;
  clear(): Promise<void>;
};

type ThreadPhotoReferencesOptions = {
  readonly clock?: () => string;
  readonly store?: PhotoReferenceStoreWithClear;
  readonly binding: () => PhotoThreadBindingSource | undefined;
};

type PhotoThreadBindingSource = {
  readonly thread_id: string;
  readonly owner_scope_ref: string;
  readonly deleted: number;
};

type PhotoThreadBinding = {
  readonly threadId: string;
  readonly ownerScopeRef: string;
  readonly deleted: boolean;
};

const clockMilliseconds = (value: string): number => {
  const parsed = v.safeParse(IsoTimestampSchema, value);
  const milliseconds = parsed.success ? Date.parse(parsed.output) : Number.NaN;
  if (!Number.isFinite(milliseconds)) throw new PhotoTokenError('INVALID_INPUT');
  return milliseconds;
};

const isValidScopeInput = (ownerScopeRef: string, threadId: string): boolean =>
  v.safeParse(OwnerScopeSchema, ownerScopeRef).success &&
  v.safeParse(OpaqueIdSchema, threadId).success;

const isValidGetInput = (
  ownerScopeRef: string,
  threadId: string,
  handle: string,
  deviceIdHash: string,
): boolean =>
  isValidScopeInput(ownerScopeRef, threadId) &&
  v.safeParse(HandleSchema, handle).success &&
  v.safeParse(HandleSchema, deviceIdHash).success;

const putFailure = (error: unknown): PhotoReferencePutResult => {
  if (!(error instanceof PhotoTokenError)) throw error;
  if (error.code === 'REFERENCE_CONFLICT') {
    return { ok: false, code: 'REFERENCE_CONFLICT' };
  }
  return { ok: false, code: 'INVALID_INPUT' };
};

type ScopeFailure = {
  readonly ok: false;
  readonly code: 'NOT_FOUND' | 'FORBIDDEN';
};

const bindingFailure = (
  binding: PhotoThreadBinding | undefined,
  ownerScopeRef: string,
): ScopeFailure | null => {
  if (binding === undefined || binding.deleted) return { ok: false, code: 'NOT_FOUND' };
  if (binding.ownerScopeRef !== ownerScopeRef) return { ok: false, code: 'FORBIDDEN' };
  return null;
};

export const createThreadPhotoReferences = (
  options: ThreadPhotoReferencesOptions,
): ThreadPhotoReferences => {
  const store = options.store ?? createMemoryPhotoReferenceStore();
  const clock = options.clock ?? (() => new Date().toISOString());

  const binding = (): PhotoThreadBinding | undefined => {
    const source = options.binding();
    if (source === undefined) return undefined;
    return {
      threadId: source.thread_id,
      ownerScopeRef: source.owner_scope_ref,
      deleted: source.deleted === 1,
    };
  };

  const serverNow = (): string => {
    const value = clock();
    clockMilliseconds(value);
    return value;
  };

  return {
    async putPhotoReference(ownerScopeRef, record, requestedNow) {
      const current = binding();
      const initialFailure = bindingFailure(current, ownerScopeRef);
      if (initialFailure !== null) return initialFailure;
      if (current === undefined) return { ok: false, code: 'NOT_FOUND' };
      if (!isValidScopeInput(ownerScopeRef, current.threadId)) {
        return { ok: false, code: 'INVALID_INPUT' };
      }
      try {
        clockMilliseconds(requestedNow);
        const serverCurrent = serverNow();
        const parsed = v.safeParse(PhotoReferenceRecordSchema, record);
        if (
          !parsed.success ||
          parsed.output.ownerScopeRef !== ownerScopeRef ||
          parsed.output.threadId !== current.threadId ||
          Date.parse(parsed.output.expiresAt) <= Date.parse(serverCurrent) ||
          Date.parse(parsed.output.expiresAt) > Date.parse(serverCurrent) + MAX_TTL_MILLISECONDS
        ) {
          return { ok: false, code: 'INVALID_INPUT' };
        }
        await store.put(parsed.output, serverCurrent);
        const finalBinding = binding();
        const finalFailure = bindingFailure(finalBinding, ownerScopeRef);
        if (finalFailure !== null) {
          await store.clear();
          return finalFailure;
        }
        if (finalBinding === undefined || finalBinding.threadId !== current.threadId) {
          await store.clear();
          return { ok: false, code: 'INVALID_INPUT' };
        }
        return { ok: true };
      } catch (error: unknown) {
        return putFailure(error);
      }
    },

    async getPhotoReference(ownerScopeRef, handle, deviceIdHash, requestedNow) {
      const current = binding();
      const initialFailure = bindingFailure(current, ownerScopeRef);
      if (initialFailure !== null) return { ok: false, code: initialFailure.code };
      if (current === undefined) return { ok: false, code: 'NOT_FOUND' };
      if (!isValidGetInput(ownerScopeRef, current.threadId, handle, deviceIdHash)) {
        return { ok: false, code: 'INVALID_INPUT' };
      }
      try {
        clockMilliseconds(requestedNow);
        const serverCurrent = serverNow();
        const record = await store.get(handle, serverCurrent, { ownerScopeRef, deviceIdHash });
        const finalBinding = binding();
        const finalFailure = bindingFailure(finalBinding, ownerScopeRef);
        if (finalFailure !== null) return { ok: false, code: finalFailure.code };
        if (finalBinding === undefined || finalBinding.threadId !== current.threadId) {
          return { ok: false, code: 'INVALID_INPUT' };
        }
        if (record === undefined || record.threadId !== finalBinding.threadId) {
          return { ok: true, record: null };
        }
        return { ok: true, record };
      } catch (error: unknown) {
        if (error instanceof PhotoTokenError && error.code === 'INVALID_INPUT') {
          return { ok: false, code: 'INVALID_INPUT' };
        }
        throw error;
      }
    },

    clear() {
      return store.clear();
    },
  };
};
