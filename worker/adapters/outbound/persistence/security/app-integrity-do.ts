import { IsoTimestampSchema, OpaqueIdSchema } from '@ima/contracts';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import type {
  AppIntegrityChallengeStore,
  AppIntegrityKey,
  AppIntegrityKeyStore,
  AppIntegrityNonce,
  AppAttestEnvironment,
} from '@worker/security/app-integrity';

const MAX_NONCE_TTL_MS = 5 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 1_000;
const MAX_NONCE_LENGTH = 256;
const MAX_KEY_ID_LENGTH = 256;
const MAX_KEY_REF_LENGTH = 2_048;

export type AppIntegrityStoreEnvironment = Exclude<AppAttestEnvironment, 'unknown'>;

type ScopeInput = {
  readonly ownerScopeRef: string;
  readonly environment: AppIntegrityStoreEnvironment;
};

type ConsumeNonceInput = ScopeInput & {
  readonly nonce: string;
  readonly deviceId: string;
  readonly now: string;
};

type GetKeyInput = ScopeInput & {
  readonly keyId: string;
  readonly deviceId: string;
};

type AdvanceCounterInput = ScopeInput & {
  readonly keyId: string;
  readonly deviceId: string;
  readonly counter: number;
};

type RevokeKeyInput = ScopeInput & {
  readonly keyId: string;
  readonly deviceId: string;
};

export type AppIntegrityStoreRpc = {
  issueNonce(nonce: AppIntegrityNonce, environment: AppIntegrityStoreEnvironment): Promise<boolean>;
  consumeNonce(input: ConsumeNonceInput): Promise<AppIntegrityNonce | null>;
  getKey(input: GetKeyInput): Promise<AppIntegrityKey | null>;
  registerKey(
    key: AppIntegrityKey,
    environment: AppIntegrityStoreEnvironment,
  ): Promise<'registered' | 'conflict'>;
  advanceCounter(input: AdvanceCounterInput): Promise<boolean>;
  revokeKey(input: RevokeKeyInput): Promise<boolean>;
};

export type AppIntegrityNamespace = DurableObjectNamespace<AppIntegrityDO>;

type ScopeRow = {
  readonly owner_scope_ref: string;
  readonly environment: string;
};

type NonceRow = ScopeRow & {
  readonly nonce: string;
  readonly device_id: string;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
};

type KeyRow = ScopeRow & {
  readonly key_id: string;
  readonly device_id: string;
  readonly key_ref: string;
  readonly last_counter: number;
  readonly revoked: number;
};

const validEnvironment = (value: string): value is AppIntegrityStoreEnvironment =>
  value === 'development' || value === 'production';

const validText = (value: string, maxLength: number): boolean =>
  value.length > 0 && value.length <= maxLength;

const timestampMs = (value: string): number | null => {
  const parsed = v.safeParse(IsoTimestampSchema, value);
  if (!parsed.success) return null;
  const milliseconds = Date.parse(parsed.output);
  return Number.isFinite(milliseconds) ? milliseconds : null;
};

const validOwner = (value: string): boolean => v.safeParse(OpaqueIdSchema, value).success;

const validScope = (input: ScopeInput): boolean =>
  validOwner(input.ownerScopeRef) && validEnvironment(input.environment);

const validNonce = (
  nonce: AppIntegrityNonce,
  environment: AppIntegrityStoreEnvironment,
): boolean => {
  const issuedAtMs = timestampMs(nonce.issuedAt);
  const expiresAtMs = timestampMs(nonce.expiresAt);
  const nowMs = Date.now();
  return (
    validOwner(nonce.ownerScopeRef) &&
    validText(nonce.deviceId, 128) &&
    validText(nonce.nonce, MAX_NONCE_LENGTH) &&
    validEnvironment(environment) &&
    issuedAtMs !== null &&
    expiresAtMs !== null &&
    issuedAtMs <= nowMs &&
    expiresAtMs > issuedAtMs &&
    expiresAtMs - issuedAtMs <= MAX_NONCE_TTL_MS &&
    expiresAtMs <= nowMs + MAX_NONCE_TTL_MS &&
    expiresAtMs > nowMs
  );
};

const validKey = (key: AppIntegrityKey, environment: AppIntegrityStoreEnvironment): boolean =>
  validOwner(key.ownerScopeRef) &&
  validText(key.deviceId, 128) &&
  validText(key.keyId, MAX_KEY_ID_LENGTH) &&
  validText(key.keyRef, MAX_KEY_REF_LENGTH) &&
  key.lastCounter === 0 &&
  key.revoked === false &&
  validEnvironment(environment);

const ownerName = (ownerScopeRef: string): string => `nonce:${ownerScopeRef}`;
const keyName = (keyId: string): string => `key:${keyId}`;

/**
 * Durable storage for App Attest challenges and verifier-owned key references.
 * Nonces shard by owner, while keys shard by keyId so a key cannot be registered by
 * two owners in separate Durable Object instances.
 */
export class AppIntegrityDO extends DurableObject {
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(() =>
      Promise.resolve().then(() => {
        ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS app_integrity_scope (
            scope_id INTEGER PRIMARY KEY CHECK (scope_id = 1),
            owner_scope_ref TEXT NOT NULL,
            environment TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS app_integrity_nonce (
            nonce TEXT PRIMARY KEY,
            owner_scope_ref TEXT NOT NULL,
            device_id TEXT NOT NULL,
            environment TEXT NOT NULL,
            issued_at_ms INTEGER NOT NULL,
            expires_at_ms INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS app_integrity_nonce_expiry
            ON app_integrity_nonce (expires_at_ms);
          CREATE TABLE IF NOT EXISTS app_integrity_key (
            key_id TEXT PRIMARY KEY,
            owner_scope_ref TEXT NOT NULL,
            device_id TEXT NOT NULL,
            environment TEXT NOT NULL,
            key_ref TEXT NOT NULL,
            last_counter INTEGER NOT NULL,
            revoked INTEGER NOT NULL CHECK (revoked IN (0, 1))
          );
        `);
      }),
    );
  }

  private scopeMatches(input: ScopeInput): boolean {
    if (!validScope(input)) return false;
    const row = this.ctx.storage.sql
      .exec<ScopeRow>(
        'SELECT owner_scope_ref, environment FROM app_integrity_scope WHERE scope_id = 1',
      )
      .toArray()[0];
    return row?.owner_scope_ref === input.ownerScopeRef && row.environment === input.environment;
  }

  private bindScope(input: ScopeInput): boolean {
    if (!validScope(input)) return false;
    const row = this.ctx.storage.sql
      .exec<ScopeRow>(
        'SELECT owner_scope_ref, environment FROM app_integrity_scope WHERE scope_id = 1',
      )
      .toArray()[0];
    if (row !== undefined)
      return row.owner_scope_ref === input.ownerScopeRef && row.environment === input.environment;
    this.ctx.storage.sql.exec(
      'INSERT INTO app_integrity_scope (scope_id, owner_scope_ref, environment) VALUES (1, ?, ?)',
      input.ownerScopeRef,
      input.environment,
    );
    return true;
  }

  private async scheduleCleanupAlarm(): Promise<void> {
    const earliest = this.ctx.storage.sql
      .exec<{ readonly expires_at_ms: number | null }>(
        'SELECT MIN(expires_at_ms) AS expires_at_ms FROM app_integrity_nonce',
      )
      .toArray()[0]?.expires_at_ms;
    if (typeof earliest !== 'number') {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const nextAlarm = Math.max(Date.now() + 1, earliest);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > nextAlarm) await this.ctx.storage.setAlarm(nextAlarm);
  }

  async issueNonce(
    nonce: AppIntegrityNonce,
    environment: AppIntegrityStoreEnvironment,
  ): Promise<boolean> {
    await this.ready;
    if (!validNonce(nonce, environment)) return false;
    const issuedAtMs = timestampMs(nonce.issuedAt);
    const expiresAtMs = timestampMs(nonce.expiresAt);
    if (issuedAtMs === null || expiresAtMs === null) return false;
    const inserted = this.ctx.storage.transactionSync(() => {
      if (!this.bindScope({ ownerScopeRef: nonce.ownerScopeRef, environment })) return false;
      const existing = this.ctx.storage.sql
        .exec<{ readonly nonce: string }>(
          'SELECT nonce FROM app_integrity_nonce WHERE nonce = ?',
          nonce.nonce,
        )
        .toArray()[0];
      if (existing !== undefined) return false;
      this.ctx.storage.sql.exec(
        `INSERT INTO app_integrity_nonce
          (nonce, owner_scope_ref, device_id, environment, issued_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        nonce.nonce,
        nonce.ownerScopeRef,
        nonce.deviceId,
        environment,
        issuedAtMs,
        expiresAtMs,
      );
      return true;
    });
    if (inserted) await this.scheduleCleanupAlarm();
    return inserted;
  }

  async consumeNonce(input: ConsumeNonceInput): Promise<AppIntegrityNonce | null> {
    await this.ready;
    const callerNowMs = timestampMs(input.now);
    const nowMs = Date.now();
    if (
      !validScope(input) ||
      !validText(input.deviceId, 128) ||
      !validText(input.nonce, MAX_NONCE_LENGTH) ||
      callerNowMs === null ||
      callerNowMs > nowMs + MAX_CLOCK_SKEW_MS
    ) {
      return null;
    }
    const consumed = this.ctx.storage.transactionSync(() => {
      if (!this.scopeMatches(input)) return null;
      const row = this.ctx.storage.sql
        .exec<NonceRow>(
          `SELECT nonce, owner_scope_ref, device_id, environment, issued_at_ms, expires_at_ms
             FROM app_integrity_nonce
            WHERE nonce = ? AND owner_scope_ref = ? AND device_id = ? AND environment = ?`,
          input.nonce,
          input.ownerScopeRef,
          input.deviceId,
          input.environment,
        )
        .toArray()[0];
      if (
        row === undefined ||
        row.issued_at_ms > nowMs ||
        row.expires_at_ms <= nowMs ||
        callerNowMs < row.issued_at_ms
      ) {
        return null;
      }
      this.ctx.storage.sql.exec(
        'DELETE FROM app_integrity_nonce WHERE nonce = ? AND expires_at_ms > ?',
        input.nonce,
        nowMs,
      );
      return {
        ownerScopeRef: row.owner_scope_ref,
        deviceId: row.device_id,
        nonce: row.nonce,
        issuedAt: new Date(row.issued_at_ms).toISOString(),
        expiresAt: new Date(row.expires_at_ms).toISOString(),
      } satisfies AppIntegrityNonce;
    });
    await this.scheduleCleanupAlarm();
    return consumed;
  }

  async getKey(input: GetKeyInput): Promise<AppIntegrityKey | null> {
    await this.ready;
    if (
      !validScope(input) ||
      !validText(input.deviceId, 128) ||
      !validText(input.keyId, MAX_KEY_ID_LENGTH)
    ) {
      return null;
    }
    const row = this.ctx.storage.sql
      .exec<KeyRow>(
        `SELECT key_id, owner_scope_ref, device_id, environment, key_ref, last_counter, revoked
           FROM app_integrity_key WHERE key_id = ?`,
        input.keyId,
      )
      .toArray()[0];
    if (
      row === undefined ||
      !this.scopeMatches(input) ||
      row.owner_scope_ref !== input.ownerScopeRef ||
      row.device_id !== input.deviceId ||
      row.environment !== input.environment
    ) {
      return null;
    }
    return {
      ownerScopeRef: row.owner_scope_ref,
      deviceId: row.device_id,
      keyId: row.key_id,
      keyRef: row.key_ref,
      lastCounter: row.last_counter,
      revoked: row.revoked === 1,
    };
  }

  async registerKey(
    key: AppIntegrityKey,
    environment: AppIntegrityStoreEnvironment,
  ): Promise<'registered' | 'conflict'> {
    await this.ready;
    if (!validKey(key, environment)) return 'conflict';
    const registered = this.ctx.storage.transactionSync(() => {
      if (!this.bindScope({ ownerScopeRef: key.ownerScopeRef, environment })) return false;
      const existing = this.ctx.storage.sql
        .exec<{ readonly key_id: string }>(
          'SELECT key_id FROM app_integrity_key WHERE key_id = ?',
          key.keyId,
        )
        .toArray()[0];
      if (existing !== undefined) return false;
      this.ctx.storage.sql.exec(
        `INSERT INTO app_integrity_key
          (key_id, owner_scope_ref, device_id, environment, key_ref, last_counter, revoked)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        key.keyId,
        key.ownerScopeRef,
        key.deviceId,
        environment,
        key.keyRef,
        key.lastCounter,
      );
      return true;
    });
    return registered ? 'registered' : 'conflict';
  }

  async advanceCounter(input: AdvanceCounterInput): Promise<boolean> {
    await this.ready;
    if (
      !validScope(input) ||
      !validText(input.deviceId, 128) ||
      !validText(input.keyId, MAX_KEY_ID_LENGTH) ||
      !Number.isSafeInteger(input.counter) ||
      input.counter <= 0
    ) {
      return false;
    }
    return this.ctx.storage.transactionSync(() => {
      if (!this.scopeMatches(input)) return false;
      const row = this.ctx.storage.sql
        .exec<KeyRow>(
          `SELECT key_id, owner_scope_ref, device_id, environment, key_ref, last_counter, revoked
             FROM app_integrity_key WHERE key_id = ?`,
          input.keyId,
        )
        .toArray()[0];
      if (
        row === undefined ||
        row.owner_scope_ref !== input.ownerScopeRef ||
        row.device_id !== input.deviceId ||
        row.environment !== input.environment ||
        row.revoked === 1 ||
        input.counter <= row.last_counter
      ) {
        return false;
      }
      this.ctx.storage.sql.exec(
        'UPDATE app_integrity_key SET last_counter = ? WHERE key_id = ? AND last_counter < ?',
        input.counter,
        input.keyId,
        input.counter,
      );
      return true;
    });
  }

  async revokeKey(input: RevokeKeyInput): Promise<boolean> {
    await this.ready;
    if (
      !validScope(input) ||
      !validText(input.deviceId, 128) ||
      !validText(input.keyId, MAX_KEY_ID_LENGTH)
    ) {
      return false;
    }
    return this.ctx.storage.transactionSync(() => {
      if (!this.scopeMatches(input)) return false;
      const row = this.ctx.storage.sql
        .exec<KeyRow>(
          'SELECT key_id, owner_scope_ref, device_id, environment, key_ref, last_counter, revoked FROM app_integrity_key WHERE key_id = ?',
          input.keyId,
        )
        .toArray()[0];
      if (
        row === undefined ||
        row.owner_scope_ref !== input.ownerScopeRef ||
        row.device_id !== input.deviceId ||
        row.environment !== input.environment ||
        row.revoked === 1
      ) {
        return false;
      }
      this.ctx.storage.sql.exec(
        'UPDATE app_integrity_key SET revoked = 1 WHERE key_id = ? AND revoked = 0',
        input.keyId,
      );
      return true;
    });
  }

  async alarm(): Promise<void> {
    await this.ready;
    this.ctx.storage.sql.exec(
      'DELETE FROM app_integrity_nonce WHERE expires_at_ms <= ?',
      Date.now(),
    );
    await this.scheduleCleanupAlarm();
  }
}

export type DurableAppIntegrityStores = {
  readonly challenges: AppIntegrityChallengeStore;
  readonly keys: AppIntegrityKeyStore;
};

/** Binds the existing gate ports to owner/key-sharded AppIntegrityDO instances. */
export const createDurableAppIntegrityStores = (
  namespace: AppIntegrityNamespace,
  environment: AppIntegrityStoreEnvironment,
): DurableAppIntegrityStores => {
  const nonceStub = (ownerScopeRef: string): AppIntegrityStoreRpc =>
    namespace.getByName(ownerName(ownerScopeRef));
  const keyStub = (keyId: string): AppIntegrityStoreRpc => namespace.getByName(keyName(keyId));
  return {
    challenges: {
      issue: (nonce) => nonceStub(nonce.ownerScopeRef).issueNonce(nonce, environment),
      consume: (input) => nonceStub(input.ownerScopeRef).consumeNonce({ ...input, environment }),
    },
    keys: {
      get: (keyId, owner) => keyStub(keyId).getKey({ ...owner, keyId, environment }),
      register: (key) => keyStub(key.keyId).registerKey(key, environment),
      advanceCounter: (input) => keyStub(input.keyId).advanceCounter({ ...input, environment }),
      revoke: (input) => keyStub(input.keyId).revokeKey({ ...input, environment }),
    },
  };
};
