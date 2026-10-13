import * as v from 'valibot';
import { IsoTimestampSchema, OpaqueIdSchema } from '@ima/contracts';
import {
  PHOTO_TOKEN_TTL_SECONDS,
  PhotoReferenceRecordSchema,
  PhotoTokenError,
  PhotoTokenInputSchema,
  type PhotoHandleClaims,
  type PhotoReferenceStoreResolver,
  type PhotoTokenCodec,
  type PhotoTokenExpectedScope,
  type PhotoTokenInput,
} from '@worker/runtime/ports/photo';

const TOKEN_VERSION = 'p1';
const TOKEN_SEGMENT_COUNT = 3;
const MAX_TOKEN_LENGTH = 512;
const HANDLE_BYTES = 16;

const PayloadSchema = v.strictObject({
  h: v.pipe(v.string(), v.length(22)),
  o: v.pipe(v.string(), v.length(22)),
  d: v.pipe(v.string(), v.length(22)),
  i: OpaqueIdSchema,
  e: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

type Payload = v.InferOutput<typeof PayloadSchema>;

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const fromBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return toBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
};

const compactDigest = async (value: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return toBase64Url(digest.slice(0, 16));
};

const deriveKey = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(await compactDigest(`photo-token\u0000${secret}`)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );

const cryptoBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const validateClock = (value: string): number => {
  const parsed = v.safeParse(IsoTimestampSchema, value);
  const milliseconds = parsed.success ? Date.parse(parsed.output) : Number.NaN;
  if (!Number.isFinite(milliseconds)) throw new PhotoTokenError('INVALID_INPUT');
  return milliseconds;
};

const randomHandle = (): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(HANDLE_BYTES)));

const scopeMatches = async (
  payload: Payload,
  expected: PhotoTokenExpectedScope,
): Promise<boolean> => {
  const [ownerScopeDigest, deviceDigest] = await Promise.all([
    compactDigest(expected.ownerScopeRef),
    compactDigest(expected.deviceId),
  ]);
  if (payload.o !== ownerScopeDigest || payload.d !== deviceDigest) return false;
  return expected.threadId === undefined || payload.i === expected.threadId;
};

const matchingRecord = (
  record: unknown,
  payload: Payload,
  expected: PhotoTokenExpectedScope,
  expiresAt: string,
): v.InferOutput<typeof PhotoReferenceRecordSchema> | undefined => {
  const parsed = v.safeParse(PhotoReferenceRecordSchema, record);
  if (!parsed.success) return undefined;
  if (
    parsed.output.handle === payload.h &&
    parsed.output.ownerScopeRef === expected.ownerScopeRef &&
    parsed.output.deviceIdHash === payload.d &&
    parsed.output.threadId === payload.i &&
    parsed.output.expiresAt === expiresAt &&
    (parsed.output.turnId === undefined) === (parsed.output.revision === undefined)
  )
    return parsed.output;
  return undefined;
};

export const createPhotoTokenCodec = (options: {
  readonly secret?: string;
  readonly ttlSeconds?: number;
  readonly referenceResolver?: PhotoReferenceStoreResolver;
}): PhotoTokenCodec => {
  const secret = options.secret?.trim();
  if (secret === undefined || secret.length === 0) throw new PhotoTokenError('MISSING_SECRET');
  if (options.referenceResolver === undefined) {
    throw new PhotoTokenError('REFERENCE_RESOLVER_REQUIRED');
  }
  const referenceResolver = options.referenceResolver;
  const ttlSeconds = options.ttlSeconds ?? PHOTO_TOKEN_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > PHOTO_TOKEN_TTL_SECONDS) {
    throw new PhotoTokenError('INVALID_INPUT');
  }
  const key = deriveKey(secret);

  return {
    async issue(input: PhotoTokenInput, now: string): Promise<string> {
      const parsed = v.safeParse(PhotoTokenInputSchema, input);
      if (!parsed.success) throw new PhotoTokenError('INVALID_INPUT');
      const nowMilliseconds = validateClock(now);
      const suppliedExpiry = parsed.output.expiresAt;
      const expiryMilliseconds =
        suppliedExpiry === undefined
          ? nowMilliseconds + ttlSeconds * 1_000
          : validateClock(suppliedExpiry);
      if (expiryMilliseconds <= nowMilliseconds) throw new PhotoTokenError('EXPIRED');
      if (expiryMilliseconds > nowMilliseconds + ttlSeconds * 1_000) {
        throw new PhotoTokenError('INVALID_INPUT');
      }
      const expirySeconds = Math.floor(expiryMilliseconds / 1_000);
      const effectiveExpiryMilliseconds = expirySeconds * 1_000;
      if (effectiveExpiryMilliseconds <= nowMilliseconds) throw new PhotoTokenError('EXPIRED');
      const expiresAt = new Date(effectiveExpiryMilliseconds).toISOString();
      const handle = randomHandle();
      const payload: Payload = {
        h: handle,
        o: await compactDigest(parsed.output.ownerScopeRef),
        d: await compactDigest(parsed.output.deviceId),
        i: parsed.output.threadId,
        e: expirySeconds,
      };
      const body = `${TOKEN_VERSION}.${toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`;
      const mac = new Uint8Array(
        await crypto.subtle.sign('HMAC', await key, cryptoBuffer(new TextEncoder().encode(body))),
      );
      const token = `${body}.${toBase64Url(mac)}`;
      if (token.length > MAX_TOKEN_LENGTH) throw new PhotoTokenError('TOKEN_TOO_LARGE');
      const references = await referenceResolver.resolve(parsed.output.threadId);
      if (references === undefined) throw new PhotoTokenError('REFERENCE_UNAVAILABLE');
      await references.put(
        {
          handle,
          ownerScopeRef: parsed.output.ownerScopeRef,
          threadId: parsed.output.threadId,
          turnId: parsed.output.turnId,
          revision: parsed.output.revision,
          deviceIdHash: payload.d,
          photoRef: parsed.output.photoRef,
          ...(parsed.output.persist === true ? { persist: true } : {}),
          expiresAt,
        },
        now,
      );
      return token;
    },

    async verify(
      token: string,
      expected: PhotoTokenExpectedScope,
      now: string,
    ): Promise<PhotoHandleClaims> {
      const nowMilliseconds = validateClock(now);
      if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        throw new PhotoTokenError('INVALID_TOKEN');
      }
      const parts = token.split('.');
      if (parts.length !== TOKEN_SEGMENT_COUNT || parts[0] !== TOKEN_VERSION) {
        throw new PhotoTokenError('INVALID_TOKEN');
      }
      const encodedPayload = parts[1] ?? '';
      const suppliedMac = fromBase64Url(parts[2] ?? '');
      const payloadBytes = fromBase64Url(encodedPayload);
      if (payloadBytes === null || suppliedMac === null) {
        throw new PhotoTokenError('INVALID_TOKEN');
      }
      const body = `${parts[0]}.${parts[1]}`;
      const validMac = await crypto.subtle.verify(
        'HMAC',
        await key,
        cryptoBuffer(suppliedMac),
        cryptoBuffer(new TextEncoder().encode(body)),
      );
      if (!validMac) throw new PhotoTokenError('INVALID_TOKEN');
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(payloadBytes));
      } catch {
        throw new PhotoTokenError('INVALID_TOKEN');
      }
      const parsed = v.safeParse(PayloadSchema, payload);
      if (!parsed.success) throw new PhotoTokenError('INVALID_TOKEN');
      if (parsed.output.e * 1_000 <= nowMilliseconds) throw new PhotoTokenError('EXPIRED');
      if (!(await scopeMatches(parsed.output, expected))) {
        throw new PhotoTokenError('SCOPE_MISMATCH');
      }
      const expiresAt = new Date(parsed.output.e * 1_000).toISOString();
      const references = await referenceResolver.resolve(parsed.output.i);
      if (references === undefined) throw new PhotoTokenError('REFERENCE_UNAVAILABLE');
      const record = await references.get(parsed.output.h, now, {
        ownerScopeRef: expected.ownerScopeRef,
        deviceIdHash: parsed.output.d,
      });
      const matching = matchingRecord(record, parsed.output, expected, expiresAt);
      if (matching === undefined) {
        throw new PhotoTokenError('REFERENCE_UNAVAILABLE');
      }
      return {
        referenceHandle: parsed.output.h,
        ownerScopeRef: matching.ownerScopeRef,
        threadId: matching.threadId,
        ...(matching.turnId === undefined
          ? {}
          : { turnId: matching.turnId, revision: matching.revision }),
        deviceIdHash: matching.deviceIdHash,
        photoRef: matching.photoRef,
        expiresAt: matching.expiresAt,
      };
    },
  };
};
