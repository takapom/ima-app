import {
  AppAttestAssertionSchema,
  AppAttestEnrollRequestSchema,
  AppAttestNonceResponseSchema,
  IsoTimestampSchema,
} from '@ima/contracts';
import type { AppAttestNonceResponse } from '@ima/contracts';
import * as v from 'valibot';

const NONCE_TTL_MS = 5 * 60 * 1_000;
const NONCE_BYTES = 32;
const KEY_REF_MAX_LENGTH = 2_048;

export type AppIntegrityEnforcement = 'disabled' | 'internal' | 'required';
export type AppAttestEnvironment = 'development' | 'production' | 'unknown';
export type AppIntegrityPolicy = {
  readonly enforcement: AppIntegrityEnforcement;
  readonly environment: AppAttestEnvironment;
};

export type AppIntegrityRoute =
  | 'conversation_turn'
  | 'search'
  | 'place'
  | 'photos'
  | 'saved_reference_refresh'
  | 'saved_reference_create'
  | 'saved_reference_delete'
  | 'place_decide'
  | 'turn'
  | 'create_thread'
  | 'read_thread'
  | 'replay_thread'
  | 'lifecycle'
  | 'delete_thread'
  | 'events';

export type AppIntegrityFailureCode =
  | 'ASSERTION_MISSING'
  | 'ASSERTION_INVALID'
  | 'CHALLENGE_INVALID'
  | 'KEY_UNREGISTERED'
  | 'KEY_BINDING_MISMATCH'
  | 'KEY_REVOKED'
  | 'COUNTER_REPLAY'
  | 'VERIFIER_UNAVAILABLE'
  | 'VERIFIER_REJECTED'
  | 'STORE_UNAVAILABLE';

export type AppIntegrityDecision =
  | { readonly allowed: true; readonly requestHash?: string }
  | { readonly allowed: false; readonly code: AppIntegrityFailureCode };

export type AppIntegrityOwner = {
  readonly ownerScopeRef: string;
  readonly deviceId: string;
};

export type AppIntegrityNonce = AppIntegrityOwner & {
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
};

export type AppIntegrityKey = AppIntegrityOwner & {
  readonly keyId: string;
  /** Opaque verifier-owned reference; raw public key/certificate bytes never leave the store. */
  readonly keyRef: string;
  readonly lastCounter: number;
  readonly revoked: boolean;
};

export type AppIntegrityChallengeStore = {
  /** Must atomically reject an active duplicate and persist no raw request body. */
  readonly issue: (nonce: AppIntegrityNonce) => Promise<boolean>;
  /** Must atomically consume exactly one nonce and enforce its owner/device binding. */
  readonly consume: (input: {
    readonly nonce: string;
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly now: string;
  }) => Promise<AppIntegrityNonce | null>;
};

export type AppIntegrityKeyStore = {
  readonly get: (keyId: string, owner: AppIntegrityOwner) => Promise<AppIntegrityKey | null>;
  /** Implementations must make keyId ownership immutable after the first registration. */
  readonly register: (key: AppIntegrityKey) => Promise<'registered' | 'conflict'>;
  /** Must atomically require counter > lastCounter and preserve owner/device binding. */
  readonly advanceCounter: (input: {
    readonly keyId: string;
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly counter: number;
  }) => Promise<boolean>;
  readonly revoke: (input: AppIntegrityOwner & { readonly keyId: string }) => Promise<boolean>;
};

export type AppIntegrityVerifier = {
  readonly verifyAttestation: (input: {
    readonly keyId: string;
    readonly attestation: string;
    readonly nonce: string;
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly environment: AppAttestEnvironment;
  }) => Promise<
    { readonly verified: true; readonly keyRef: string } | { readonly verified: false }
  >;
  readonly verifyAssertion: (input: {
    readonly keyId: string;
    readonly keyRef: string;
    readonly assertion: string;
    readonly nonce: string;
    readonly requestHash: string;
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly environment: AppAttestEnvironment;
  }) => Promise<
    { readonly verified: true; readonly counter: number } | { readonly verified: false }
  >;
};

export type AppIntegrityGate = {
  readonly enforcement: AppIntegrityEnforcement;
  readonly environment: AppAttestEnvironment;
  readonly issueNonce: (input: {
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly requestId: string;
    readonly now: string;
  }) => Promise<AppAttestNonceResponse>;
  readonly enroll: (input: {
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly request: unknown;
    readonly now: string;
  }) => Promise<
    | { readonly registered: true }
    | { readonly registered: false; readonly code: AppIntegrityFailureCode }
  >;
  readonly authorize: (input: {
    readonly route: AppIntegrityRoute;
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly request: Request;
    readonly now: string;
    readonly maxBodyBytes: number;
    readonly rawBody?: Uint8Array | undefined;
  }) => Promise<AppIntegrityDecision>;
  readonly revoke: (input: AppIntegrityOwner & { readonly keyId: string }) => Promise<boolean>;
};

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const timestampMs = (value: string): number => {
  const parsed = v.safeParse(IsoTimestampSchema, value);
  if (!parsed.success) return Number.NaN;
  const result = Date.parse(parsed.output);
  return Number.isFinite(result) ? result : Number.NaN;
};

const validKeyRef = (value: string): boolean =>
  value.length > 0 && value.length <= KEY_REF_MAX_LENGTH;

const isProtectedRoute = (route: AppIntegrityRoute): boolean =>
  route === 'conversation_turn' ||
  route === 'search' ||
  route === 'place' ||
  route === 'photos' ||
  route === 'saved_reference_refresh' ||
  route === 'turn';

const invalidStore = (): AppIntegrityDecision => ({
  allowed: false,
  code: 'STORE_UNAVAILABLE',
});

const requestBody = async (request: Request, maxBodyBytes: number): Promise<Uint8Array> => {
  const body = request.clone().body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBodyBytes) throw new Error('APP_ATTEST_BODY_TOO_LARGE');
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const requestHash = async (
  request: Request,
  maxBodyBytes: number,
  rawBody?: Uint8Array,
): Promise<string> => {
  const body = rawBody ?? (await requestBody(request, maxBodyBytes));
  if (body.byteLength > maxBodyBytes) throw new Error('APP_ATTEST_BODY_TOO_LARGE');
  const url = new URL(request.url);
  const path = url.pathname + url.search;
  const prefix = new TextEncoder().encode(`${request.method}\n${path}\n`);
  const input = new Uint8Array(prefix.byteLength + body.byteLength);
  input.set(prefix);
  input.set(body, prefix.byteLength);
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
};

const nonceResponse = (nonce: AppIntegrityNonce, requestId: string): AppAttestNonceResponse => {
  const parsed = v.safeParse(AppAttestNonceResponseSchema, {
    schemaVersion: 'v1',
    requestId,
    nonce: nonce.nonce,
    expiresAt: nonce.expiresAt,
  });
  if (!parsed.success) throw new Error('APP_ATTEST_NONCE_INVALID');
  return parsed.output;
};

const failure = (code: AppIntegrityFailureCode): AppIntegrityDecision => ({
  allowed: false,
  code,
});

export const resolveAppIntegrityPolicy = (input: {
  readonly deploymentEnvironment?: string;
  readonly environment?: string;
  readonly enforcement?: string;
}): AppIntegrityPolicy => {
  const external =
    input.deploymentEnvironment !== undefined && input.deploymentEnvironment !== 'dev';
  const environment: AppAttestEnvironment =
    input.environment === 'production'
      ? 'production'
      : input.environment === 'development' && !external
        ? 'development'
        : input.environment === undefined || input.environment === ''
          ? external
            ? 'unknown'
            : 'development'
          : 'unknown';
  const explicit = input.enforcement;
  const enforcement: AppIntegrityEnforcement =
    external && explicit !== 'required'
      ? 'required'
      : explicit === 'disabled'
        ? 'disabled'
        : explicit === 'internal'
          ? 'internal'
          : explicit === 'required'
            ? 'required'
            : environment === 'production' || environment === 'unknown'
              ? 'required'
              : explicit === undefined || explicit === ''
                ? 'internal'
                : 'required';
  return { enforcement, environment };
};

export const createAppIntegrityGate = (input: {
  readonly enforcement: AppIntegrityEnforcement;
  readonly environment?: AppAttestEnvironment;
  readonly challenges?: AppIntegrityChallengeStore;
  readonly keys?: AppIntegrityKeyStore;
  readonly verifier?: AppIntegrityVerifier;
  readonly nonceTtlMs?: number;
}): AppIntegrityGate => {
  const nonceTtlMs =
    input.nonceTtlMs !== undefined && Number.isSafeInteger(input.nonceTtlMs) && input.nonceTtlMs > 0
      ? Math.min(input.nonceTtlMs, NONCE_TTL_MS)
      : NONCE_TTL_MS;

  const issueNonce = async (request: {
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly requestId: string;
    readonly now: string;
  }): Promise<AppAttestNonceResponse> => {
    const issuedMs = timestampMs(request.now);
    if (
      !Number.isFinite(issuedMs) ||
      input.challenges === undefined ||
      (input.enforcement === 'required' && (input.environment ?? 'unknown') === 'unknown')
    ) {
      throw new Error('APP_ATTEST_NONCE_UNAVAILABLE');
    }
    const bytes = new Uint8Array(NONCE_BYTES);
    crypto.getRandomValues(bytes);
    const nonce: AppIntegrityNonce = {
      ownerScopeRef: request.ownerScopeRef,
      deviceId: request.deviceId,
      nonce: base64Url(bytes),
      issuedAt: new Date(issuedMs).toISOString(),
      expiresAt: new Date(issuedMs + nonceTtlMs).toISOString(),
    };
    if (!(await input.challenges.issue(nonce))) throw new Error('APP_ATTEST_NONCE_RATE_LIMITED');
    return nonceResponse(nonce, request.requestId);
  };

  const enroll = async (request: {
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly request: unknown;
    readonly now: string;
  }): Promise<
    | { readonly registered: true }
    | { readonly registered: false; readonly code: AppIntegrityFailureCode }
  > => {
    if (
      input.enforcement === 'disabled' ||
      input.challenges === undefined ||
      input.keys === undefined
    ) {
      return { registered: false, code: 'VERIFIER_UNAVAILABLE' };
    }
    if (
      input.verifier === undefined ||
      (input.enforcement === 'required' && (input.environment ?? 'unknown') === 'unknown')
    ) {
      return { registered: false, code: 'VERIFIER_UNAVAILABLE' };
    }
    const parsed = v.safeParse(AppAttestEnrollRequestSchema, request.request);
    if (!parsed.success) return { registered: false, code: 'ASSERTION_INVALID' };
    const nowMs = timestampMs(request.now);
    if (!Number.isFinite(nowMs)) return { registered: false, code: 'ASSERTION_INVALID' };
    let consumed: AppIntegrityNonce | null;
    try {
      consumed = await input.challenges.consume({
        nonce: parsed.output.nonce,
        ownerScopeRef: request.ownerScopeRef,
        deviceId: request.deviceId,
        now: request.now,
      });
    } catch {
      return { registered: false, code: 'STORE_UNAVAILABLE' };
    }
    if (consumed === null) return { registered: false, code: 'CHALLENGE_INVALID' };
    let verified: Awaited<ReturnType<AppIntegrityVerifier['verifyAttestation']>>;
    try {
      verified = await input.verifier.verifyAttestation({
        keyId: parsed.output.keyId,
        attestation: parsed.output.attestation,
        nonce: parsed.output.nonce,
        ownerScopeRef: request.ownerScopeRef,
        deviceId: request.deviceId,
        environment: input.environment ?? 'unknown',
      });
    } catch {
      return { registered: false, code: 'VERIFIER_REJECTED' };
    }
    if (!verified.verified || !validKeyRef(verified.keyRef)) {
      return { registered: false, code: 'VERIFIER_REJECTED' };
    }
    let registered: Awaited<ReturnType<AppIntegrityKeyStore['register']>>;
    try {
      registered = await input.keys.register({
        keyId: parsed.output.keyId,
        keyRef: verified.keyRef,
        ownerScopeRef: request.ownerScopeRef,
        deviceId: request.deviceId,
        lastCounter: 0,
        revoked: false,
      });
    } catch {
      return { registered: false, code: 'STORE_UNAVAILABLE' };
    }
    return registered === 'registered'
      ? { registered: true }
      : { registered: false, code: 'KEY_BINDING_MISMATCH' };
  };

  const authorize = async (request: {
    readonly route: AppIntegrityRoute;
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly request: Request;
    readonly now: string;
    readonly maxBodyBytes: number;
    readonly rawBody?: Uint8Array | undefined;
  }): Promise<AppIntegrityDecision> => {
    if (input.enforcement === 'disabled' || !isProtectedRoute(request.route)) {
      return { allowed: true };
    }
    const keyId = request.request.headers.get('X-App-Attest-KeyId') ?? '';
    const nonce = request.request.headers.get('X-App-Attest-Nonce') ?? '';
    const assertion = request.request.headers.get('X-App-Attest-Assert') ?? '';
    const hasAny = keyId.length > 0 || nonce.length > 0 || assertion.length > 0;
    if (!hasAny && input.enforcement === 'internal') return { allowed: true };
    if (!hasAny) return failure('ASSERTION_MISSING');
    if (input.enforcement === 'required' && (input.environment ?? 'unknown') === 'unknown') {
      return failure('VERIFIER_UNAVAILABLE');
    }
    const parsed = v.safeParse(AppAttestAssertionSchema, { keyId, nonce, assertion });
    if (!parsed.success) return failure('ASSERTION_INVALID');
    if (
      input.challenges === undefined ||
      input.keys === undefined ||
      input.verifier === undefined
    ) {
      return invalidStore();
    }
    const nowMs = timestampMs(request.now);
    if (!Number.isFinite(nowMs)) return failure('ASSERTION_INVALID');
    let consumed: AppIntegrityNonce | null;
    try {
      consumed = await input.challenges.consume({
        nonce: parsed.output.nonce,
        ownerScopeRef: request.ownerScopeRef,
        deviceId: request.deviceId,
        now: request.now,
      });
    } catch {
      return invalidStore();
    }
    if (consumed === null) return failure('CHALLENGE_INVALID');
    let key: AppIntegrityKey | null;
    try {
      key = await input.keys.get(parsed.output.keyId, {
        ownerScopeRef: request.ownerScopeRef,
        deviceId: request.deviceId,
      });
    } catch {
      return invalidStore();
    }
    if (key === null) return failure('KEY_UNREGISTERED');
    if (key.revoked) return failure('KEY_REVOKED');
    if (key.ownerScopeRef !== request.ownerScopeRef || key.deviceId !== request.deviceId) {
      return failure('KEY_BINDING_MISMATCH');
    }
    let hash: string;
    try {
      hash = await requestHash(request.request, request.maxBodyBytes, request.rawBody);
    } catch {
      return failure('ASSERTION_INVALID');
    }
    let verified: Awaited<ReturnType<AppIntegrityVerifier['verifyAssertion']>>;
    try {
      verified = await input.verifier.verifyAssertion({
        keyId: key.keyId,
        keyRef: key.keyRef,
        assertion: parsed.output.assertion,
        nonce: parsed.output.nonce,
        requestHash: hash,
        ownerScopeRef: request.ownerScopeRef,
        deviceId: request.deviceId,
        environment: input.environment ?? 'unknown',
      });
    } catch {
      return failure('VERIFIER_REJECTED');
    }
    if (!verified.verified || !Number.isSafeInteger(verified.counter) || verified.counter <= 0) {
      return failure('VERIFIER_REJECTED');
    }
    let advanced: boolean;
    try {
      advanced = await input.keys.advanceCounter({
        keyId: key.keyId,
        ownerScopeRef: request.ownerScopeRef,
        deviceId: request.deviceId,
        counter: verified.counter,
      });
    } catch {
      return invalidStore();
    }
    return advanced ? { allowed: true, requestHash: hash } : failure('COUNTER_REPLAY');
  };

  const revoke = (request: AppIntegrityOwner & { readonly keyId: string }): Promise<boolean> =>
    input.keys?.revoke(request) ?? Promise.resolve(false);

  return {
    enforcement: input.enforcement,
    environment: input.environment ?? 'unknown',
    issueNonce,
    enroll,
    authorize,
    revoke,
  };
};

export const protectedAppIntegrityRoute = (route: AppIntegrityRoute): boolean =>
  isProtectedRoute(route);
