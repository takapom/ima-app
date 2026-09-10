import * as v from 'valibot';
import {
  OpaqueIdSchema,
  SavedPlaceReferenceSchema,
  SavedPlaceRegistrationSchema,
  SavedPlaceRefSchema,
  type SavedPlaceReference,
} from '@ima/core';

const TABLE_NAME = 'm16_saved_place_reference';
const USED_REF_TABLE_NAME = 'm16_saved_place_reference_used';

export type SavedReferenceIdFactory = {
  readonly nextSavedPlaceRef: () => string;
};

export type SavedReferenceStoreErrorCode =
  'INVALID_INPUT' | 'INVALID_GENERATED_ID' | 'REFERENCE_CONFLICT' | 'CORRUPT_ROW';

export type SavedReferenceRegistrationResult =
  | { readonly ok: true; readonly created: boolean; readonly reference: SavedPlaceReference }
  | { readonly ok: false; readonly code: SavedReferenceStoreErrorCode };

export type SavedReferenceReadResult =
  | { readonly ok: true; readonly reference: SavedPlaceReference | null }
  | { readonly ok: false; readonly code: 'INVALID_INPUT' | 'CORRUPT_ROW' };

export type SavedReferenceDeleteResult =
  | { readonly ok: true; readonly deleted: boolean }
  | { readonly ok: false; readonly code: 'INVALID_INPUT' | 'CORRUPT_ROW' };

export type DurableSavedReferenceStore = {
  readonly register: (input: unknown) => SavedReferenceRegistrationResult;
  readonly read: (ownerScopeRef: unknown, savedPlaceRef: unknown) => SavedReferenceReadResult;
  readonly remove: (ownerScopeRef: unknown, savedPlaceRef: unknown) => SavedReferenceDeleteResult;
};

type ReferenceRow = {
  readonly saved_place_ref: string;
  readonly owner_scope_ref: string;
  readonly provider: string;
  readonly record_ref: string;
};

const referenceFromRow = (row: ReferenceRow): SavedPlaceReference | undefined => {
  const parsed = v.safeParse(SavedPlaceReferenceSchema, {
    savedPlaceRef: row.saved_place_ref,
    ownerScopeRef: row.owner_scope_ref,
    provider: row.provider,
    recordRef: row.record_ref,
  });
  return parsed.success ? parsed.output : undefined;
};

const parseOwnerAndRef = (
  ownerScopeRef: unknown,
  savedPlaceRef: unknown,
): { readonly ownerScopeRef: string; readonly savedPlaceRef: string } | undefined => {
  const owner = v.safeParse(OpaqueIdSchema, ownerScopeRef);
  const saved = v.safeParse(SavedPlaceRefSchema, savedPlaceRef);
  if (!owner.success || !saved.success) return undefined;
  return { ownerScopeRef: owner.output, savedPlaceRef: saved.output };
};

const rowFor = (
  storage: DurableObjectStorage,
  ownerScopeRef: string,
  savedPlaceRef: string,
): ReferenceRow | undefined =>
  storage.sql
    .exec<ReferenceRow>(
      `SELECT saved_place_ref, owner_scope_ref, provider, record_ref
         FROM ${TABLE_NAME}
        WHERE saved_place_ref = ? AND owner_scope_ref = ?`,
      savedPlaceRef,
      ownerScopeRef,
    )
    .toArray()[0];

export const initializeDurableSavedReferenceStore = (storage: DurableObjectStorage): void => {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      saved_place_ref TEXT PRIMARY KEY,
      owner_scope_ref TEXT NOT NULL,
      provider TEXT NOT NULL,
      record_ref TEXT NOT NULL,
      UNIQUE (owner_scope_ref, provider, record_ref)
    )
  `);
  storage.sql.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE_NAME}_owner ON ${TABLE_NAME} (owner_scope_ref)`,
  );
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${USED_REF_TABLE_NAME} (
      saved_place_ref TEXT PRIMARY KEY
    )
  `);
};

/**
 * Durable owner-scoped identity storage. The host chooses the DO shard; this
 * adapter deliberately stores no provider payload or Core runtime state.
 */
export const createDurableSavedReferenceStore = (
  storage: DurableObjectStorage,
  ids: SavedReferenceIdFactory,
): DurableSavedReferenceStore => {
  initializeDurableSavedReferenceStore(storage);

  const register = (input: unknown): SavedReferenceRegistrationResult => {
    const parsed = v.safeParse(SavedPlaceRegistrationSchema, input);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
    const registration = parsed.output;
    return storage.transactionSync(() => {
      const existing = storage.sql
        .exec<ReferenceRow>(
          `SELECT saved_place_ref, owner_scope_ref, provider, record_ref
             FROM ${TABLE_NAME}
            WHERE owner_scope_ref = ? AND provider = ? AND record_ref = ?`,
          registration.ownerScopeRef,
          registration.provider,
          registration.recordRef,
        )
        .toArray()[0];
      if (existing !== undefined) {
        const reference = referenceFromRow(existing);
        return reference === undefined
          ? { ok: false, code: 'CORRUPT_ROW' }
          : { ok: true, created: false, reference };
      }

      const generated = v.safeParse(SavedPlaceRefSchema, ids.nextSavedPlaceRef());
      if (!generated.success) return { ok: false, code: 'INVALID_GENERATED_ID' };
      const sameRef = storage.sql
        .exec<ReferenceRow>(
          `SELECT saved_place_ref, owner_scope_ref, provider, record_ref
             FROM ${TABLE_NAME}
            WHERE saved_place_ref = ?`,
          generated.output,
        )
        .toArray()[0];
      if (sameRef !== undefined) return { ok: false, code: 'REFERENCE_CONFLICT' };

      const usedRef = storage.sql
        .exec<{ readonly saved_place_ref: string }>(
          `SELECT saved_place_ref FROM ${USED_REF_TABLE_NAME} WHERE saved_place_ref = ?`,
          generated.output,
        )
        .toArray()[0];
      if (usedRef !== undefined) return { ok: false, code: 'REFERENCE_CONFLICT' };

      const row = {
        saved_place_ref: generated.output,
        owner_scope_ref: registration.ownerScopeRef,
        provider: registration.provider,
        record_ref: registration.recordRef,
      } satisfies ReferenceRow;
      const reference = referenceFromRow(row);
      if (reference === undefined) return { ok: false, code: 'CORRUPT_ROW' };
      storage.sql.exec(
        `INSERT INTO ${USED_REF_TABLE_NAME} (saved_place_ref) VALUES (?)`,
        generated.output,
      );
      storage.sql.exec(
        `INSERT INTO ${TABLE_NAME} (saved_place_ref, owner_scope_ref, provider, record_ref)
         VALUES (?, ?, ?, ?)`,
        reference.savedPlaceRef,
        reference.ownerScopeRef,
        reference.provider,
        reference.recordRef,
      );
      return { ok: true, created: true, reference };
    });
  };

  const read = (ownerScopeRef: unknown, savedPlaceRef: unknown): SavedReferenceReadResult => {
    const parsedScope = parseOwnerAndRef(ownerScopeRef, savedPlaceRef);
    if (parsedScope === undefined) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    const row = rowFor(storage, parsedScope.ownerScopeRef, parsedScope.savedPlaceRef);
    if (row === undefined) return { ok: true, reference: null };
    const reference = referenceFromRow(row);
    return reference === undefined ? { ok: false, code: 'CORRUPT_ROW' } : { ok: true, reference };
  };

  const remove = (ownerScopeRef: unknown, savedPlaceRef: unknown): SavedReferenceDeleteResult => {
    const parsedScope = parseOwnerAndRef(ownerScopeRef, savedPlaceRef);
    if (parsedScope === undefined) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    return storage.transactionSync(() => {
      const row = rowFor(storage, parsedScope.ownerScopeRef, parsedScope.savedPlaceRef);
      if (row === undefined) return { ok: true, deleted: false };
      if (referenceFromRow(row) === undefined) return { ok: false, code: 'CORRUPT_ROW' };
      const deleted = storage.sql.exec(
        `DELETE FROM ${TABLE_NAME} WHERE saved_place_ref = ? AND owner_scope_ref = ?`,
        parsedScope.savedPlaceRef,
        parsedScope.ownerScopeRef,
      ).rowsWritten;
      return { ok: true, deleted: deleted === 1 };
    });
  };

  return { register, read, remove };
};
