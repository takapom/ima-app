import { OpaqueIdSchema } from '@ima/core';
import * as v from 'valibot';
import type {
  SavedReferenceDeleteResult,
  SavedReferenceOperationOptions,
  SavedReferenceReadResult,
  SavedReferenceRegistrationResult,
  SavedReferenceReplayResult,
} from './store';

const OWNER_NAME_PREFIX = 'saved-reference-owner:';

export type SavedReferenceOwnerInitResult =
  | { readonly ok: true; readonly created: boolean }
  | { readonly ok: false; readonly code: 'INVALID_INPUT' | 'OWNER_CONFLICT' };

export type SavedReferenceOwnerOperationFailure = {
  readonly ok: false;
  readonly code: 'INVALID_INPUT' | 'OWNER_NOT_INITIALIZED' | 'FORBIDDEN';
};

export type SavedReferenceRpcRegistrationResult =
  SavedReferenceRegistrationResult | SavedReferenceOwnerOperationFailure;
export type SavedReferenceRpcReadResult =
  SavedReferenceReadResult | SavedReferenceOwnerOperationFailure;
export type SavedReferenceRpcDeleteResult =
  SavedReferenceDeleteResult | SavedReferenceOwnerOperationFailure;
export type SavedReferenceRpcReplayResult =
  SavedReferenceReplayResult | SavedReferenceOwnerOperationFailure;

/** RPC methods exposed by the saved-reference Durable Object stub. */
export type SavedReferenceDOStub = DurableObjectStub & {
  readonly initialize: (ownerScopeRef: unknown) => Promise<SavedReferenceOwnerInitResult>;
  readonly register: (
    ownerScopeRef: unknown,
    input: unknown,
    options?: SavedReferenceOperationOptions,
  ) => Promise<SavedReferenceRpcRegistrationResult>;
  readonly replay: (
    ownerScopeRef: unknown,
    idempotencyKey: unknown,
    idempotencyFingerprint: unknown,
  ) => Promise<SavedReferenceRpcReplayResult>;
  readonly read: (
    ownerScopeRef: unknown,
    savedPlaceRef: unknown,
  ) => Promise<SavedReferenceRpcReadResult>;
  readonly remove: (
    ownerScopeRef: unknown,
    savedPlaceRef: unknown,
    options?: SavedReferenceOperationOptions,
  ) => Promise<SavedReferenceRpcDeleteResult>;
};

/** Structural binding type kept free of the Durable Object class module. */
export type SavedReferenceNamespace = {
  readonly getByName: (name: string) => SavedReferenceDOStub;
};

export type OwnerSavedReferenceRpc = {
  readonly initialize: () => Promise<SavedReferenceOwnerInitResult>;
  readonly replay: (
    idempotencyKey: unknown,
    idempotencyFingerprint: unknown,
  ) => Promise<SavedReferenceRpcReplayResult>;
  readonly register: (
    input: unknown,
    options?: SavedReferenceOperationOptions,
  ) => Promise<SavedReferenceRpcRegistrationResult>;
  readonly read: (savedPlaceRef: unknown) => Promise<SavedReferenceRpcReadResult>;
  readonly remove: (
    savedPlaceRef: unknown,
    options?: SavedReferenceOperationOptions,
  ) => Promise<SavedReferenceRpcDeleteResult>;
};

const parseOwner = (value: string): string | undefined => {
  const parsed = v.safeParse(OpaqueIdSchema, value);
  return parsed.success ? parsed.output : undefined;
};

/** Returns the only supported namespace key for an owner-sharded saved-reference DO. */
export const savedReferenceOwnerName = (ownerScopeRef: string): string => {
  const owner = parseOwner(ownerScopeRef);
  if (owner === undefined) throw new Error('INVALID_OWNER_SCOPE');
  return `${OWNER_NAME_PREFIX}${owner}`;
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
    replay: (idempotencyKey, idempotencyFingerprint) =>
      stub.replay(owner, idempotencyKey, idempotencyFingerprint),
    register: (input, options) => stub.register(owner, input, options),
    read: (savedPlaceRef) => stub.read(owner, savedPlaceRef),
    remove: (savedPlaceRef, options) => stub.remove(owner, savedPlaceRef, options),
  };
};
