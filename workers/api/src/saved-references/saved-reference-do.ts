import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { OpaqueIdSchema, Text } from '@ima/core';
import {
  createDurableSavedReferenceStore,
  type DurableSavedReferenceStore,
  type SavedReferenceOperationOptions,
} from './store';
import type {
  SavedReferenceOwnerInitResult,
  SavedReferenceOwnerOperationFailure,
  SavedReferenceRpcDeleteResult,
  SavedReferenceRpcReadResult,
  SavedReferenceRpcRegistrationResult,
  SavedReferenceRpcReplayResult,
} from './saved-reference-rpc';
export { createOwnerSavedReferenceRpc } from './saved-reference-rpc';
export { savedReferenceOwnerName } from './saved-reference-rpc';
export type {
  OwnerSavedReferenceRpc,
  SavedReferenceDOStub,
  SavedReferenceNamespace,
  SavedReferenceOwnerInitResult,
  SavedReferenceRpcDeleteResult,
  SavedReferenceRpcReadResult,
  SavedReferenceRpcRegistrationResult,
  SavedReferenceRpcReplayResult,
} from './saved-reference-rpc';

const OWNER_TABLE_NAME = 'm16_saved_reference_owner';
const OWNER_ROW_ID = 1;

export const SavedReferenceIdentitySchema = v.strictObject({
  provider: Text(80),
  recordRef: Text(512),
});
export type SavedReferenceIdentity = v.InferOutput<typeof SavedReferenceIdentitySchema>;

type OwnerRow = {
  readonly owner_scope_ref: string;
};

const parseOwner = (value: unknown): string | undefined => {
  const parsed = v.safeParse(OpaqueIdSchema, value);
  return parsed.success ? parsed.output : undefined;
};

const createReferenceIds = () => ({
  nextSavedPlaceRef: (): string => `saved-${crypto.randomUUID()}`,
});

/**
 * Durable owner-shard for saved references. Its lifecycle is independent from
 * ThreadDO; deleting a thread must not delete this object's identity rows.
 */
export class SavedReferenceDO extends DurableObject {
  private readonly ready: Promise<DurableSavedReferenceStore>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(() =>
      Promise.resolve().then(() => {
        ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS ${OWNER_TABLE_NAME} (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            owner_scope_ref TEXT NOT NULL
          )
        `);
        return createDurableSavedReferenceStore(ctx.storage, createReferenceIds());
      }),
    );
  }

  private ownerRow(): OwnerRow | undefined {
    return this.ctx.storage.sql
      .exec<OwnerRow>(
        `SELECT owner_scope_ref FROM ${OWNER_TABLE_NAME} WHERE singleton = ${OWNER_ROW_ID}`,
      )
      .toArray()[0];
  }

  private ownerForOperation(ownerScopeRef: unknown): string | SavedReferenceOwnerOperationFailure {
    const owner = parseOwner(ownerScopeRef);
    if (owner === undefined) return { ok: false, code: 'INVALID_INPUT' };
    const bound = this.ownerRow();
    if (bound === undefined) return { ok: false, code: 'OWNER_NOT_INITIALIZED' };
    if (bound.owner_scope_ref !== owner) return { ok: false, code: 'FORBIDDEN' };
    return owner;
  }

  async initialize(ownerScopeRef: unknown): Promise<SavedReferenceOwnerInitResult> {
    await this.ready;
    const owner = parseOwner(ownerScopeRef);
    if (owner === undefined) return { ok: false, code: 'INVALID_INPUT' };
    return this.ctx.storage.transactionSync(() => {
      const bound = this.ownerRow();
      if (bound === undefined) {
        this.ctx.storage.sql.exec(
          `INSERT INTO ${OWNER_TABLE_NAME} (singleton, owner_scope_ref) VALUES (?, ?)`,
          OWNER_ROW_ID,
          owner,
        );
        return { ok: true, created: true };
      }
      return bound.owner_scope_ref === owner
        ? { ok: true, created: false }
        : { ok: false, code: 'OWNER_CONFLICT' };
    });
  }

  async register(
    ownerScopeRef: unknown,
    input: unknown,
    options?: SavedReferenceOperationOptions,
  ): Promise<SavedReferenceRpcRegistrationResult> {
    const store = await this.ready;
    const owner = this.ownerForOperation(ownerScopeRef);
    if (typeof owner !== 'string') return owner;
    const parsed = v.safeParse(SavedReferenceIdentitySchema, input);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
    return store.register({ ownerScopeRef: owner, ...parsed.output }, options);
  }

  async replay(
    ownerScopeRef: unknown,
    idempotencyKey: unknown,
    idempotencyFingerprint: unknown,
  ): Promise<SavedReferenceRpcReplayResult> {
    const store = await this.ready;
    const owner = this.ownerForOperation(ownerScopeRef);
    if (typeof owner !== 'string') return owner;
    return store.replay(owner, idempotencyKey, idempotencyFingerprint);
  }

  async read(ownerScopeRef: unknown, savedPlaceRef: unknown): Promise<SavedReferenceRpcReadResult> {
    const store = await this.ready;
    const owner = this.ownerForOperation(ownerScopeRef);
    if (typeof owner !== 'string') return owner;
    return store.read(owner, savedPlaceRef);
  }

  async remove(
    ownerScopeRef: unknown,
    savedPlaceRef: unknown,
    options?: SavedReferenceOperationOptions,
  ): Promise<SavedReferenceRpcDeleteResult> {
    const store = await this.ready;
    const owner = this.ownerForOperation(ownerScopeRef);
    if (typeof owner !== 'string') return owner;
    return store.remove(owner, savedPlaceRef, options);
  }
}
