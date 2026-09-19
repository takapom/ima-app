import type {
  SavedReferenceIdFactory,
  SavedReferenceOperationOptions,
  SavedReferenceRegistrationResult,
  SavedReferenceReplayResult,
  SavedReferenceReadResult,
  SavedReferenceDeleteResult,
} from '@worker/application/ports/saved-reference-store';

import * as v from 'valibot';
import { OpaqueIdSchema, SavedPlaceRefSchema } from '@worker/domain/primitives';
import {
  SavedPlaceReferenceSchema,
  SavedPlaceRegistrationSchema,
  type SavedPlaceReference,
} from '@worker/domain/candidates/continuity';

const TABLE_NAME = 'm16_saved_place_reference';
const USED_REF_TABLE_NAME = 'm16_saved_place_reference_used';
const OPERATION_TABLE_NAME = 'm16_saved_reference_operation';

export type {
  SavedReferenceIdFactory,
  SavedReferenceStoreErrorCode,
  SavedReferenceOperationOptions,
  SavedReferenceRegistrationResult,
  SavedReferenceReplayResult,
  SavedReferenceReadResult,
  SavedReferenceDeleteResult,
} from '@worker/application/ports/saved-reference-store';

export type DurableSavedReferenceStore = {
  readonly register: (
    input: unknown,
    options?: SavedReferenceOperationOptions,
  ) => SavedReferenceRegistrationResult;
  readonly replay: (
    ownerScopeRef: unknown,
    idempotencyKey: unknown,
    idempotencyFingerprint: unknown,
  ) => SavedReferenceReplayResult;
  readonly read: (ownerScopeRef: unknown, savedPlaceRef: unknown) => SavedReferenceReadResult;
  readonly remove: (
    ownerScopeRef: unknown,
    savedPlaceRef: unknown,
    options?: SavedReferenceOperationOptions,
  ) => SavedReferenceDeleteResult;
};

type ReferenceRow = {
  readonly saved_place_ref: string;
  readonly owner_scope_ref: string;
  readonly provider: string;
  readonly record_ref: string;
};

type OperationRow = {
  readonly owner_scope_ref: string;
  readonly idempotency_key: string;
  readonly operation: 'register' | 'remove';
  readonly fingerprint: string | null;
  readonly provider: string | null;
  readonly record_ref: string | null;
  readonly saved_place_ref: string;
  readonly deleted: number;
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

const operationFor = (
  storage: DurableObjectStorage,
  ownerScopeRef: string,
  idempotencyKey: string,
): OperationRow | undefined =>
  storage.sql
    .exec<OperationRow>(
      `SELECT owner_scope_ref, idempotency_key, operation, fingerprint, provider, record_ref, saved_place_ref, deleted
         FROM ${OPERATION_TABLE_NAME}
        WHERE owner_scope_ref = ? AND idempotency_key = ?`,
      ownerScopeRef,
      idempotencyKey,
    )
    .toArray()[0];

const parsedOperationKey = (
  options: SavedReferenceOperationOptions | undefined,
): string | null | undefined => {
  if (options?.idempotencyKey === undefined) return null;
  const parsed = v.safeParse(OpaqueIdSchema, options.idempotencyKey);
  return parsed.success ? parsed.output : undefined;
};

const parsedFingerprint = (
  options: SavedReferenceOperationOptions | undefined,
): string | null | undefined => {
  if (options?.idempotencyFingerprint === undefined) return null;
  const parsed = v.safeParse(OpaqueIdSchema, options.idempotencyFingerprint);
  return parsed.success ? parsed.output : undefined;
};

const insertOperation = (
  storage: DurableObjectStorage,
  input: {
    readonly ownerScopeRef: string;
    readonly idempotencyKey: string;
    readonly operation: 'register' | 'remove';
    readonly fingerprint: string | null;
    readonly provider: string | null;
    readonly recordRef: string | null;
    readonly savedPlaceRef: string;
    readonly deleted: boolean;
  },
): void => {
  storage.sql.exec(
    `INSERT INTO ${OPERATION_TABLE_NAME}
       (owner_scope_ref, idempotency_key, operation, fingerprint, provider, record_ref, saved_place_ref, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.ownerScopeRef,
    input.idempotencyKey,
    input.operation,
    input.fingerprint,
    input.provider,
    input.recordRef,
    input.savedPlaceRef,
    input.deleted ? 1 : 0,
  );
};

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
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${OPERATION_TABLE_NAME} (
      owner_scope_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('register', 'remove')),
      fingerprint TEXT,
      provider TEXT,
      record_ref TEXT,
      saved_place_ref TEXT NOT NULL,
      deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
      PRIMARY KEY (owner_scope_ref, idempotency_key)
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

  const register = (
    input: unknown,
    options?: SavedReferenceOperationOptions,
  ): SavedReferenceRegistrationResult => {
    const parsed = v.safeParse(SavedPlaceRegistrationSchema, input);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
    const idempotencyKey = parsedOperationKey(options);
    if (idempotencyKey === undefined) return { ok: false, code: 'INVALID_INPUT' };
    const fingerprint = parsedFingerprint(options);
    if (fingerprint === undefined) return { ok: false, code: 'INVALID_INPUT' };
    if (idempotencyKey === null && fingerprint !== null) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    const registration = parsed.output;
    return storage.transactionSync(() => {
      const prior =
        idempotencyKey === null
          ? undefined
          : operationFor(storage, registration.ownerScopeRef, idempotencyKey);
      if (prior !== undefined) {
        if (
          prior.operation !== 'register' ||
          prior.fingerprint !== fingerprint ||
          prior.provider !== registration.provider ||
          prior.record_ref !== registration.recordRef
        )
          return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
        const replay = rowFor(storage, registration.ownerScopeRef, prior.saved_place_ref);
        if (replay === undefined) return { ok: false, code: 'REFERENCE_CONFLICT' };
        const reference = referenceFromRow(replay);
        return reference === undefined
          ? { ok: false, code: 'CORRUPT_ROW' }
          : { ok: true, created: false, reference };
      }
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
        if (reference === undefined) return { ok: false, code: 'CORRUPT_ROW' };
        if (idempotencyKey !== null)
          insertOperation(storage, {
            ownerScopeRef: registration.ownerScopeRef,
            idempotencyKey,
            operation: 'register',
            fingerprint,
            provider: registration.provider,
            recordRef: registration.recordRef,
            savedPlaceRef: reference.savedPlaceRef,
            deleted: false,
          });
        return { ok: true, created: false, reference };
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
      if (idempotencyKey !== null)
        insertOperation(storage, {
          ownerScopeRef: registration.ownerScopeRef,
          idempotencyKey,
          operation: 'register',
          fingerprint,
          provider: registration.provider,
          recordRef: registration.recordRef,
          savedPlaceRef: reference.savedPlaceRef,
          deleted: false,
        });
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

  const replay = (
    ownerScopeRef: unknown,
    idempotencyKey: unknown,
    idempotencyFingerprint: unknown,
  ): SavedReferenceReplayResult => {
    const owner = v.safeParse(OpaqueIdSchema, ownerScopeRef);
    const key = v.safeParse(OpaqueIdSchema, idempotencyKey);
    const fingerprint = v.safeParse(OpaqueIdSchema, idempotencyFingerprint);
    if (!owner.success || !key.success || !fingerprint.success) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    const prior = operationFor(storage, owner.output, key.output);
    if (prior === undefined) return { ok: true, found: false };
    if (prior.operation !== 'register' || prior.fingerprint !== fingerprint.output) {
      return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
    }
    const row = rowFor(storage, owner.output, prior.saved_place_ref);
    if (row === undefined) return { ok: false, code: 'REFERENCE_CONFLICT' };
    const reference = referenceFromRow(row);
    return reference === undefined
      ? { ok: false, code: 'CORRUPT_ROW' }
      : { ok: true, found: true, reference };
  };

  const remove = (
    ownerScopeRef: unknown,
    savedPlaceRef: unknown,
    options?: SavedReferenceOperationOptions,
  ): SavedReferenceDeleteResult => {
    const parsedScope = parseOwnerAndRef(ownerScopeRef, savedPlaceRef);
    if (parsedScope === undefined) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    const idempotencyKey = parsedOperationKey(options);
    if (idempotencyKey === undefined) return { ok: false, code: 'INVALID_INPUT' };
    const fingerprint = parsedFingerprint(options);
    if (fingerprint === undefined) return { ok: false, code: 'INVALID_INPUT' };
    if (idempotencyKey === null && fingerprint !== null) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    return storage.transactionSync(() => {
      const prior =
        idempotencyKey === null
          ? undefined
          : operationFor(storage, parsedScope.ownerScopeRef, idempotencyKey);
      if (prior !== undefined) {
        return prior.operation === 'remove' &&
          prior.saved_place_ref === parsedScope.savedPlaceRef &&
          prior.fingerprint === fingerprint
          ? { ok: true, deleted: prior.deleted === 1 }
          : { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
      }
      const row = rowFor(storage, parsedScope.ownerScopeRef, parsedScope.savedPlaceRef);
      if (row === undefined) {
        if (idempotencyKey !== null)
          insertOperation(storage, {
            ownerScopeRef: parsedScope.ownerScopeRef,
            idempotencyKey,
            operation: 'remove',
            fingerprint,
            provider: null,
            recordRef: null,
            savedPlaceRef: parsedScope.savedPlaceRef,
            deleted: false,
          });
        return { ok: true, deleted: false };
      }
      if (referenceFromRow(row) === undefined) return { ok: false, code: 'CORRUPT_ROW' };
      const deleted = storage.sql.exec(
        `DELETE FROM ${TABLE_NAME} WHERE saved_place_ref = ? AND owner_scope_ref = ?`,
        parsedScope.savedPlaceRef,
        parsedScope.ownerScopeRef,
      ).rowsWritten;
      if (deleted === 1) {
        if (idempotencyKey !== null)
          insertOperation(storage, {
            ownerScopeRef: parsedScope.ownerScopeRef,
            idempotencyKey,
            operation: 'remove',
            fingerprint,
            provider: null,
            recordRef: null,
            savedPlaceRef: parsedScope.savedPlaceRef,
            deleted: true,
          });
        storage.sql.exec(
          `UPDATE ${OPERATION_TABLE_NAME}
              SET provider = NULL, record_ref = NULL
            WHERE owner_scope_ref = ? AND saved_place_ref = ?`,
          parsedScope.ownerScopeRef,
          parsedScope.savedPlaceRef,
        );
      }
      return { ok: true, deleted: deleted === 1 };
    });
  };

  return { register, replay, read, remove };
};
