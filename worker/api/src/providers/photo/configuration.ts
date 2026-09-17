import { createPhotoTokenCodec } from '@api/providers/photo/token';
import {
  createPhotoReferenceStoreResolver,
  type PhotoReferenceRpc,
} from '@api/providers/photo/rpc';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isThreadNamespace = (value: unknown): value is { getByName(id: string): unknown } =>
  isRecord(value) && typeof value.getByName === 'function';
const isPhotoRpc = (value: unknown): value is PhotoReferenceRpc =>
  isRecord(value) &&
  typeof value.putPhotoReference === 'function' &&
  typeof value.getPhotoReference === 'function';
const secretValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

/** The codec domain-separates its signing key, so the existing cursor secret is a safe fallback. */
export const configuredPhotoTokenCodec = (env: unknown) => {
  if (!isRecord(env)) return undefined;
  const secret = secretValue(env.PHOTO_TOKEN_SECRET) ?? secretValue(env.PLACES_CURSOR_SECRET);
  const threads = env.THREADS;
  if (secret === undefined || !isThreadNamespace(threads)) return undefined;
  return createPhotoTokenCodec({
    secret,
    referenceResolver: createPhotoReferenceStoreResolver((threadId) => {
      const rpc = threads.getByName(threadId);
      if (!isPhotoRpc(rpc)) throw new Error('RUNTIME_PHOTO_THREADS_UNAVAILABLE');
      return rpc;
    }),
  });
};
