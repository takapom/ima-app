import * as v from 'valibot';
import { OpaqueIdSchema } from '@ima/core';
import type {
  OwnerDecideInput,
  OwnerDecideResult,
  OwnerPrefsPutInput,
  OwnerPrefsPutResult,
  OwnerPrefsReadResult,
  OwnerRegisterResult,
  OwnerSavedListResult,
  OwnerStore,
  SavedReferenceDeleteResult,
  SavedReferenceOperationOptions,
  SavedReferenceReadResult,
  SavedReferenceReplayResult,
} from '@ima/core';
import {
  savedReferenceOwnerName,
  type SavedReferenceDOStub,
  type SavedReferenceNamespace,
  type SavedReferenceRpcDecideResult,
  type SavedReferenceRpcDeleteResult,
  type SavedReferenceRpcListResult,
  type SavedReferenceRpcPrefsPutResult,
  type SavedReferenceRpcPrefsReadResult,
  type SavedReferenceRpcReadResult,
  type SavedReferenceRpcReplayResult,
} from '@worker/adapters/outbound/persistence/saved-references/saved-reference-rpc';

const invalidInput: { readonly ok: false; readonly code: 'INVALID_INPUT' } = {
  ok: false,
  code: 'INVALID_INPUT',
};

const parseOwner = (ownerScopeRef: string): string | undefined => {
  const parsed = v.safeParse(OpaqueIdSchema, ownerScopeRef);
  return parsed.success ? parsed.output : undefined;
};

const unexpectedOwnerFailure = (code: string): never => {
  throw new Error(`OWNER_STORE_UNEXPECTED:${code}`);
};

const unreadPrefs = (): OwnerPrefsReadResult => ({ ok: true, revision: 0, prefs: null });
const emptyList = (): OwnerSavedListResult => ({ ok: true, references: [], decided: [] });

const bindOwner = async (
  stub: SavedReferenceDOStub,
  owner: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: 'INVALID_INPUT' }> => {
  const initialized = await stub.initialize(owner);
  if (initialized.ok) return { ok: true };
  if (initialized.code === 'INVALID_INPUT') return invalidInput;
  return unexpectedOwnerFailure(initialized.code);
};

const prefsReadFromRpc = (result: SavedReferenceRpcPrefsReadResult): OwnerPrefsReadResult => {
  if (result.ok) return result;
  if (result.code === 'INVALID_INPUT') return invalidInput;
  if (result.code === 'OWNER_NOT_INITIALIZED') return unreadPrefs();
  return unexpectedOwnerFailure(result.code);
};

const prefsPutFromRpc = (result: SavedReferenceRpcPrefsPutResult): OwnerPrefsPutResult => {
  if (result.ok) return result;
  if (result.code === 'INVALID_INPUT') return invalidInput;
  if (result.code === 'REVISION_CONFLICT') return { ok: false, code: 'REVISION_CONFLICT' };
  return unexpectedOwnerFailure(result.code);
};

const listFromRpc = (result: SavedReferenceRpcListResult): OwnerSavedListResult => {
  if (result.ok) return result;
  if (result.code === 'INVALID_INPUT') return invalidInput;
  if (result.code === 'OWNER_NOT_INITIALIZED') return emptyList();
  return unexpectedOwnerFailure(result.code);
};

const replayFromRpc = (result: SavedReferenceRpcReplayResult): SavedReferenceReplayResult => {
  if (result.ok) return result;
  if (result.code === 'INVALID_INPUT') return invalidInput;
  if (result.code === 'REFERENCE_CONFLICT') return { ok: false, code: 'REFERENCE_CONFLICT' };
  if (result.code === 'IDEMPOTENCY_CONFLICT') return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
  if (result.code === 'CORRUPT_ROW') return { ok: false, code: 'CORRUPT_ROW' };
  if (result.code === 'OWNER_NOT_INITIALIZED') return { ok: true, found: false };
  return unexpectedOwnerFailure(result.code);
};

const readFromRpc = (result: SavedReferenceRpcReadResult): SavedReferenceReadResult => {
  if (result.ok) return result;
  if (result.code === 'INVALID_INPUT') return invalidInput;
  if (result.code === 'CORRUPT_ROW') return { ok: false, code: 'CORRUPT_ROW' };
  if (result.code === 'OWNER_NOT_INITIALIZED') return { ok: true, reference: null };
  return unexpectedOwnerFailure(result.code);
};

const removeFromRpc = (result: SavedReferenceRpcDeleteResult): SavedReferenceDeleteResult => {
  if (result.ok) return result;
  if (result.code === 'INVALID_INPUT') return invalidInput;
  if (result.code === 'IDEMPOTENCY_CONFLICT') return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
  if (result.code === 'CORRUPT_ROW') return { ok: false, code: 'CORRUPT_ROW' };
  return unexpectedOwnerFailure(result.code);
};

/**
 * OwnerStore over owner-named SavedReferenceDO shards.
 * initialize stays an adapter concern and is not part of the port.
 */
export const createDurableOwnerStore = (namespace: SavedReferenceNamespace): OwnerStore => {
  const stubFor = (owner: string): SavedReferenceDOStub =>
    namespace.getByName(savedReferenceOwnerName(owner));

  const readPrefs = async (ownerScopeRef: string): Promise<OwnerPrefsReadResult> => {
    const owner = parseOwner(ownerScopeRef);
    if (owner === undefined) return invalidInput;
    return prefsReadFromRpc(await stubFor(owner).readPrefs(owner));
  };

  const putPrefs = async (
    ownerScopeRef: string,
    input: OwnerPrefsPutInput,
  ): Promise<OwnerPrefsPutResult> => {
    const owner = parseOwner(ownerScopeRef);
    if (owner === undefined) return invalidInput;
    const stub = stubFor(owner);
    const bound = await bindOwner(stub, owner);
    if (!bound.ok) return bound;
    return prefsPutFromRpc(await stub.putPrefs(owner, input));
  };

  const listSaved = async (ownerScopeRef: string): Promise<OwnerSavedListResult> => {
    const owner = parseOwner(ownerScopeRef);
    if (owner === undefined) return invalidInput;
    return listFromRpc(await stubFor(owner).listSaved(owner));
  };

  const decideFromRpc = (result: SavedReferenceRpcDecideResult): OwnerDecideResult => {
    if (result.ok) return result;
    if (result.code === 'INVALID_INPUT') return invalidInput;
    if (
      result.code === 'IDEMPOTENCY_CONFLICT' ||
      result.code === 'REFERENCE_CONFLICT' ||
      result.code === 'CORRUPT_ROW' ||
      result.code === 'INVALID_GENERATED_ID'
    ) {
      return { ok: false, code: result.code };
    }
    return unexpectedOwnerFailure(result.code);
  };

  const decide = async (
    ownerScopeRef: string,
    input: OwnerDecideInput,
    options?: SavedReferenceOperationOptions,
  ): Promise<OwnerDecideResult> => {
    const owner = parseOwner(ownerScopeRef);
    if (owner === undefined) return invalidInput;
    const stub = stubFor(owner);
    const bound = await bindOwner(stub, owner);
    if (!bound.ok) return bound;
    return decideFromRpc(await stub.decide(owner, input, options));
  };

  const register = async (
    ownerScopeRef: string,
    input: { readonly provider: string; readonly recordRef: string },
    options?: SavedReferenceOperationOptions,
  ): Promise<OwnerRegisterResult> => {
    const owner = parseOwner(ownerScopeRef);
    if (owner === undefined) return invalidInput;
    const stub = stubFor(owner);
    const bound = await bindOwner(stub, owner);
    if (!bound.ok) return bound;
    return stub.register(owner, input, options);
  };

  const replay = async (
    ownerScopeRef: string,
    idempotencyKey: unknown,
    idempotencyFingerprint: unknown,
  ): Promise<SavedReferenceReplayResult> => {
    const owner = parseOwner(ownerScopeRef);
    if (owner === undefined) return invalidInput;
    return replayFromRpc(
      await stubFor(owner).replay(owner, idempotencyKey, idempotencyFingerprint),
    );
  };

  const read = async (
    ownerScopeRef: string,
    savedPlaceRef: string,
  ): Promise<SavedReferenceReadResult> => {
    const owner = parseOwner(ownerScopeRef);
    if (owner === undefined) return invalidInput;
    return readFromRpc(await stubFor(owner).read(owner, savedPlaceRef));
  };

  const remove = async (
    ownerScopeRef: string,
    savedPlaceRef: string,
    options?: SavedReferenceOperationOptions,
  ): Promise<SavedReferenceDeleteResult> => {
    const owner = parseOwner(ownerScopeRef);
    if (owner === undefined) return invalidInput;
    const stub = stubFor(owner);
    const bound = await bindOwner(stub, owner);
    if (!bound.ok) return bound;
    return removeFromRpc(await stub.remove(owner, savedPlaceRef, options));
  };

  return { readPrefs, putPrefs, listSaved, decide, register, replay, read, remove };
};
