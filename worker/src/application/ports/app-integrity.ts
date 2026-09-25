export type AppIntegrityEnforcement = 'disabled' | 'internal' | 'required';
export type AppAttestEnvironment = 'development' | 'production' | 'unknown';
export type AppIntegrityPolicy = {
  readonly enforcement: AppIntegrityEnforcement;
  readonly environment: AppAttestEnvironment;
};

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

/** Generates an unpredictable challenge; the application controls its lifetime and binding. */
export type AppIntegrityNonceGenerator = { readonly generate: () => string };
export type AppIntegrityAssertion = {
  readonly keyId: string;
  readonly nonce: string;
  readonly assertion: string;
};
export type AppIntegrityEnrollment = {
  readonly keyId: string;
  readonly nonce: string;
  readonly attestation: string;
};
/** Request-specific proof supplied by the transport; hashing stays after nonce/key checks. */
export type AppIntegrityRequestProof = { readonly hash: () => Promise<string> };
