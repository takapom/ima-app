import * as v from 'valibot';
import { IsoTimestampSchema } from '@worker/domain/primitives';
import type {
  AppIntegrityEnforcement,
  AppAttestEnvironment,
  AppIntegrityNonce,
  AppIntegrityKey,
  AppIntegrityChallengeStore,
  AppIntegrityKeyStore,
  AppIntegrityVerifier,
  AppIntegrityFailureCode,
  AppIntegrityDecision,
  AppIntegrityOwner,
  AppIntegrityNonceGenerator,
  AppIntegrityAssertion,
  AppIntegrityEnrollment,
  AppIntegrityRequestProof,
} from '@worker/application/ports/app-integrity';
const NONCE_TTL_MS = 5 * 60 * 1_000;
const KEY_REF_MAX_LENGTH = 2_048;

/**
 * 端末の App Attest を owner と device に束ねる手順。
 * Apple の検証とストア実装は Port のままにし、nonce の寿命、鍵登録、認可、失効の判断だけを持つ。
 */
export type AppIntegrityApplication = {
  readonly enforcement: AppIntegrityEnforcement;
  readonly environment: AppAttestEnvironment;
  /** 一度きりの challenge を発行する。発行不能は例外にし、検証拒否と再試行を混ぜない。 */
  readonly issueNonce: (input: {
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly now: string;
  }) => Promise<AppIntegrityNonce>;
  /** attestation を検証して鍵を登録する。nonce は検証の前に消費し、同じ challenge の再送を登録成功にしない。 */
  readonly enroll: (input: {
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly enrollment: AppIntegrityEnrollment | null;
    readonly now: string;
  }) => Promise<
    | { readonly registered: true }
    | { readonly registered: false; readonly code: AppIntegrityFailureCode }
  >;
  /** 保護された要求の assertion を検証し、counter が進んだときだけ許可する。無効化と対象外の経路は assertion なしで通す。 */
  readonly authorize: (input: {
    readonly protected: boolean;
    readonly hasAssertion: boolean;
    readonly assertion: AppIntegrityAssertion | null;
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly proof: AppIntegrityRequestProof;
    readonly now: string;
  }) => Promise<AppIntegrityDecision>;
  /** 登録済み鍵を失効する。鍵ストアが無い構成では false を返し、失効できたことにしない。 */
  readonly revoke: (input: AppIntegrityOwner & { readonly keyId: string }) => Promise<boolean>;
};

/**
 * createAppIntegrityApplication に渡す Port と方針。
 * nonce の寿命は呼び出し側が既定より延ばせず、上限は NONCE_TTL_MS で切る。
 */
export type AppIntegrityOptions = {
  readonly nonceGenerator: AppIntegrityNonceGenerator;
  readonly enforcement: AppIntegrityEnforcement;
  readonly environment?: AppAttestEnvironment;
  readonly challenges?: AppIntegrityChallengeStore;
  readonly keys?: AppIntegrityKeyStore;
  readonly verifier?: AppIntegrityVerifier;
  readonly nonceTtlMs?: number;
};
const timestampMs = (value: string): number => {
  const parsed = v.safeParse(IsoTimestampSchema, value);
  if (!parsed.success) return Number.NaN;
  const result = Date.parse(parsed.output);
  return Number.isFinite(result) ? result : Number.NaN;
};

const validKeyRef = (value: string): boolean =>
  value.length > 0 && value.length <= KEY_REF_MAX_LENGTH;

/** ストア障害は検証拒否と分け、STORE_UNAVAILABLE に閉じる。 */
const invalidStore = (): AppIntegrityDecision => ({
  allowed: false,
  code: 'STORE_UNAVAILABLE',
});

const failure = (code: AppIntegrityFailureCode): AppIntegrityDecision => ({
  allowed: false,
  code,
});

/**
 * enforcement と注入 Port から App Integrity 手順を組み立てる。
 * 時刻と乱数は引数で受け、enforcement に応じて fail-closed する。
 */
export const createAppIntegrityApplication = (
  input: AppIntegrityOptions,
): AppIntegrityApplication => {
  const nonceTtlMs =
    input.nonceTtlMs !== undefined && Number.isSafeInteger(input.nonceTtlMs) && input.nonceTtlMs > 0
      ? Math.min(input.nonceTtlMs, NONCE_TTL_MS)
      : NONCE_TTL_MS;

  const issueNonce = async (request: {
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly now: string;
  }): Promise<AppIntegrityNonce> => {
    const issuedMs = timestampMs(request.now);
    if (
      !Number.isFinite(issuedMs) ||
      input.challenges === undefined ||
      (input.enforcement === 'required' && (input.environment ?? 'unknown') === 'unknown')
    ) {
      throw new Error('APP_ATTEST_NONCE_UNAVAILABLE');
    }
    const nonce: AppIntegrityNonce = {
      ownerScopeRef: request.ownerScopeRef,
      deviceId: request.deviceId,
      nonce: input.nonceGenerator.generate(),
      issuedAt: new Date(issuedMs).toISOString(),
      expiresAt: new Date(issuedMs + nonceTtlMs).toISOString(),
    };
    if (!(await input.challenges.issue(nonce))) throw new Error('APP_ATTEST_NONCE_RATE_LIMITED');
    return nonce;
  };

  const enroll = async (request: {
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly enrollment: AppIntegrityEnrollment | null;
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
    const enrollment = request.enrollment;
    if (enrollment === null) return { registered: false, code: 'ASSERTION_INVALID' };
    const nowMs = timestampMs(request.now);
    if (!Number.isFinite(nowMs)) return { registered: false, code: 'ASSERTION_INVALID' };
    let consumed: AppIntegrityNonce | null;
    try {
      consumed = await input.challenges.consume({
        nonce: enrollment.nonce,
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
        keyId: enrollment.keyId,
        attestation: enrollment.attestation,
        nonce: enrollment.nonce,
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
        keyId: enrollment.keyId,
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
    readonly protected: boolean;
    readonly hasAssertion: boolean;
    readonly assertion: AppIntegrityAssertion | null;
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly proof: AppIntegrityRequestProof;
    readonly now: string;
  }): Promise<AppIntegrityDecision> => {
    if (input.enforcement === 'disabled' || !request.protected) {
      return { allowed: true };
    }
    const hasAny = request.hasAssertion;
    if (!hasAny && input.enforcement === 'internal') return { allowed: true };
    if (!hasAny) return failure('ASSERTION_MISSING');
    if (input.enforcement === 'required' && (input.environment ?? 'unknown') === 'unknown') {
      return failure('VERIFIER_UNAVAILABLE');
    }
    const assertion = request.assertion;
    if (assertion === null) return failure('ASSERTION_INVALID');
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
        nonce: assertion.nonce,
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
      key = await input.keys.get(assertion.keyId, {
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
      hash = await request.proof.hash();
    } catch {
      return failure('ASSERTION_INVALID');
    }
    let verified: Awaited<ReturnType<AppIntegrityVerifier['verifyAssertion']>>;
    try {
      verified = await input.verifier.verifyAssertion({
        keyId: key.keyId,
        keyRef: key.keyRef,
        assertion: assertion.assertion,
        nonce: assertion.nonce,
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
