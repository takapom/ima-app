import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { OpaqueIdSchema, Text } from '@ima/core';
import {
  createDurableSavedReferenceStore,
  type DurableSavedReferenceStore,
  type SavedReferenceDeleteResult,
  type SavedReferenceReadResult,
  type SavedReferenceRegistrationResult,
} from './store';

const OWNER_TABLE_NAME = 'm16_saved_reference_owner';
const OWNER_ROW_ID = 1;
const OWNER_NAME_PREFIX = 'saved-reference-owner:';

export const SavedReferenceIdentitySchema = v.strictObject({
  provider: Text(80),
  recordRef: Text(512),
});
export type SavedReferenceIdentity = v.InferOutput<typeof SavedReferenceIdentitySchema>;

export type SavedReferenceOwnerInitResult =
  | { readonly ok: true; readonly created: boolean }
  | { readonly ok: false; readonly code: 'INVALID_INPUT' | 'OWNER_CONFLICT' };

type OwnerOperationFailure = {
  readonly ok: false;
  readonly code: 'INVALID_INPUT' | 'OWNER_NOT_INITIALIZED' | 'FORBIDDEN';
};

export type SavedReferenceRpcRegistrationResult =
  SavedReferenceRegistrationResult | OwnerOperationFailure;
export type SavedReferenceRpcReadResult = SavedReferenceReadResult | OwnerOperationFailure;
export type SavedReferenceRpcDeleteResult = SavedReferenceDeleteResult | OwnerOperationFailure;

export type SavedReferenceNamespace = DurableObjectNamespace<SavedReferenceDO>;

type OwnerRow = {
  readonly owner_scope_ref: string;
};

const parseOwner = (value: unknown): string | undefined => {
  const parsed = v.safeParse(OpaqueIdSchema, value);
  return parsed.success ? parsed.output : undefined;
};

/** Returns the only supported namespace key for an owner-sharded saved-reference DO. */
export const savedReferenceOwnerName = (ownerScopeRef: string): string => {
  const owner = parseOwner(ownerScopeRef);
  if (owner === undefined) throw new Error('INVALID_OWNER_SCOPE');
  return `${OWNER_NAME_PREFIX}${owner}`;
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

  private ownerForOperation(ownerScopeRef: unknown): string | OwnerOperationFailure {
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
  ): Promise<SavedReferenceRpcRegistrationResult> {
    const store = await this.ready;
    const owner = this.ownerForOperation(ownerScopeRef);
    if (typeof owner !== 'string') return owner;
    const parsed = v.safeParse(SavedReferenceIdentitySchema, input);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
    return store.register({ ownerScopeRef: owner, ...parsed.output });
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
  ): Promise<SavedReferenceRpcDeleteResult> {
    const store = await this.ready;
    const owner = this.ownerForOperation(ownerScopeRef);
    if (typeof owner !== 'string') return owner;
    return store.remove(owner, savedPlaceRef);
  }
}

export type OwnerSavedReferenceRpc = {
  readonly initialize: () => Promise<SavedReferenceOwnerInitResult>;
  readonly register: (input: unknown) => Promise<SavedReferenceRpcRegistrationResult>;
  readonly read: (savedPlaceRef: unknown) => Promise<SavedReferenceRpcReadResult>;
  readonly remove: (savedPlaceRef: unknown) => Promise<SavedReferenceRpcDeleteResult>;
};

/** Binds all calls to the owner-derived DO name and owner argument. */
export const createOwnerSavedReferenceRpc = (
  namespace: SavedReferenceNamespace,
  ownerScopeRef: string,
): OwnerSavedReferenceRpc => {
  const owner = parseOwner(ownerScopeRef);
  if (owner === undefined) throw new Error('INVALID_OWNER_SCOPE');
  const stub = namespace.getByName(savedReferenceOwnerName(owner));
  return {
    initialize: () => stub.initialize(owner),
    register: (input) => stub.register(owner, input),
    read: (savedPlaceRef) => stub.read(owner, savedPlaceRef),
    remove: (savedPlaceRef) => stub.remove(owner, savedPlaceRef),
  };
};
