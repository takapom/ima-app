import * as v from 'valibot';
import { IsoTimestampSchema, OpaqueIdSchema } from '@ima/contracts';

export const PHOTO_TOKEN_TTL_SECONDS = 30 * 60;

export const PhotoResourceNameSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
  v.regex(/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/u),
);

export const PhotoTokenInputSchema = v.strictObject({
  ownerScopeRef: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  threadId: OpaqueIdSchema,
  deviceId: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  photoRef: PhotoResourceNameSchema,
  expiresAt: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(40))),
});
export type PhotoTokenInput = v.InferOutput<typeof PhotoTokenInputSchema>;

export type PhotoHandleClaims = {
  readonly referenceHandle: string;
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly deviceIdHash: string;
  readonly photoRef: string;
  readonly expiresAt: string;
};

export type PhotoTokenExpectedScope = {
  readonly ownerScopeRef: string;
  /** Every HTTP verification is bound to the authenticated device. */
  readonly deviceId: string;
  readonly threadId?: string;
};

export type PhotoTokenCodec = {
  issue(input: PhotoTokenInput, now: string): Promise<string>;
  verify(token: string, expected: PhotoTokenExpectedScope, now: string): Promise<PhotoHandleClaims>;
};

export type PhotoReferenceRecord = {
  readonly handle: string;
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly deviceIdHash: string;
  readonly photoRef: string;
  readonly expiresAt: string;
};

/**
 * The implementation is owned by the per-thread runtime boundary. An eviction
 * may discard the reference; callers then receive REFERENCE_UNAVAILABLE/410
 * and must obtain a new provider observation before issuing another token.
 */
export type PhotoReferenceStore = {
  put(record: PhotoReferenceRecord): Promise<void>;
  get(handle: string, now: string): Promise<PhotoReferenceRecord | undefined>;
};

/** Resolves the per-thread store after the authenticated token reveals its route. */
export type PhotoReferenceStoreResolver = {
  resolve(threadId: string): Promise<PhotoReferenceStore | undefined>;
};

export const PhotoReferenceRecordSchema = v.strictObject({
  handle: v.pipe(v.string(), v.length(22)),
  ownerScopeRef: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  threadId: OpaqueIdSchema,
  deviceIdHash: v.pipe(v.string(), v.length(22)),
  photoRef: PhotoResourceNameSchema,
  expiresAt: IsoTimestampSchema,
});

export type PhotoTokenErrorCode =
  | 'MISSING_SECRET'
  | 'INVALID_TOKEN'
  | 'INVALID_INPUT'
  | 'SCOPE_MISMATCH'
  | 'EXPIRED'
  | 'TOKEN_TOO_LARGE'
  | 'REFERENCE_RESOLVER_REQUIRED'
  | 'REFERENCE_CONFLICT'
  | 'REFERENCE_UNAVAILABLE';

export class PhotoTokenError extends Error {
  readonly code: PhotoTokenErrorCode;

  constructor(code: PhotoTokenErrorCode) {
    super(`photo token denied: ${code}`);
    this.name = 'PhotoTokenError';
    this.code = code;
  }
}
