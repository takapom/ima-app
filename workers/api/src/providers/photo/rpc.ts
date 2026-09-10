import * as v from 'valibot';
import { IsoTimestampSchema } from '@ima/contracts';
import {
  PhotoReferenceRecordSchema,
  PhotoTokenError,
  type PhotoReferenceRecord,
  type PhotoReferenceStore,
  type PhotoReferenceStoreResolver,
} from './types';

export type PhotoReferencePutResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_INPUT' | 'REFERENCE_CONFLICT';
    };

export type PhotoReferenceGetResult =
  | { readonly ok: true; readonly record: PhotoReferenceRecord | null }
  | {
      readonly ok: false;
      readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_INPUT';
    };

/** RPC surface implemented by the per-thread Durable Object. */
export type PhotoReferenceRpc = {
  putPhotoReference(
    ownerScopeRef: string,
    record: PhotoReferenceRecord,
    now: string,
  ): Promise<PhotoReferencePutResult>;
  getPhotoReference(
    ownerScopeRef: string,
    handle: string,
    deviceIdHash: string,
    now: string,
  ): Promise<PhotoReferenceGetResult>;
};

const validNow = (value: string): boolean => {
  const parsed = v.safeParse(IsoTimestampSchema, value);
  return parsed.success && Number.isFinite(Date.parse(parsed.output));
};

const putError = (
  code: Exclude<PhotoReferencePutResult, { ok: true }>['code'],
): PhotoTokenError => {
  switch (code) {
    case 'REFERENCE_CONFLICT':
      return new PhotoTokenError('REFERENCE_CONFLICT');
    case 'INVALID_INPUT':
      return new PhotoTokenError('INVALID_INPUT');
    case 'NOT_FOUND':
    case 'FORBIDDEN':
      return new PhotoTokenError('REFERENCE_UNAVAILABLE');
  }
};

const getError = (
  code: Exclude<PhotoReferenceGetResult, { ok: true }>['code'],
): PhotoTokenError => {
  switch (code) {
    case 'INVALID_INPUT':
      return new PhotoTokenError('INVALID_INPUT');
    case 'NOT_FOUND':
    case 'FORBIDDEN':
      return new PhotoTokenError('REFERENCE_UNAVAILABLE');
  }
};

/** Adapts ThreadDO RPC to the token codec without exposing a global/request-local map. */
export const createPhotoReferenceStoreResolver = (
  resolve: (threadId: string) => PhotoReferenceRpc,
): PhotoReferenceStoreResolver => ({
  resolve(threadId: string): Promise<PhotoReferenceStore> {
    const rpc = resolve(threadId);
    return Promise.resolve({
      put: async (record: PhotoReferenceRecord, requestedNow?: string): Promise<void> => {
        const parsed = v.safeParse(PhotoReferenceRecordSchema, record);
        if (!parsed.success) throw new PhotoTokenError('INVALID_INPUT');
        const now = requestedNow ?? new Date().toISOString();
        if (!validNow(now)) throw new PhotoTokenError('INVALID_INPUT');
        const result = await rpc.putPhotoReference(parsed.output.ownerScopeRef, parsed.output, now);
        if (!result.ok) throw putError(result.code);
      },
      get: async (handle, now, scope) => {
        if (!validNow(now)) throw new PhotoTokenError('INVALID_INPUT');
        if (scope === undefined) throw new PhotoTokenError('INVALID_INPUT');
        const result = await rpc.getPhotoReference(
          scope.ownerScopeRef,
          handle,
          scope.deviceIdHash,
          now,
        );
        if (!result.ok) throw getError(result.code);
        return result.record ?? undefined;
      },
    });
  },
});
