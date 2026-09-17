import * as v from 'valibot';
import { IsoTimestampSchema, SavedPlaceRegistrationSchema } from '@ima/core';
import type { OwnerDecideInput, OwnerDecideResult } from './owner-store';
import type { DurableSavedReferenceStore, SavedReferenceOperationOptions } from './store';

const REFERENCE_TABLE = 'm16_saved_place_reference';
const OPERATION_TABLE = 'm16_saved_decide_operation';

type DecideOperationRow = {
  readonly fingerprint: string | null;
  readonly saved_place_ref: string;
  readonly decided_at: string;
};

const invalidInput: { readonly ok: false; readonly code: 'INVALID_INPUT' } = {
  ok: false,
  code: 'INVALID_INPUT',
};

const parsedOperationKey = (
  options: SavedReferenceOperationOptions | undefined,
): string | null | undefined => {
  if (options?.idempotencyKey === undefined) return null;
  const parsed = v.safeParse(v.pipe(v.string(), v.minLength(1)), options.idempotencyKey);
  return parsed.success ? parsed.output : undefined;
};

const parsedFingerprint = (
  options: SavedReferenceOperationOptions | undefined,
): string | null | undefined => {
  if (options?.idempotencyFingerprint === undefined) return null;
  const parsed = v.safeParse(v.pipe(v.string(), v.minLength(1)), options.idempotencyFingerprint);
  return parsed.success ? parsed.output : undefined;
};

export const initializeOwnerDecideStore = (storage: DurableObjectStorage): void => {
  const columns = new Set(
    storage.sql
      .exec<{ readonly name: string }>(`PRAGMA table_info(${REFERENCE_TABLE})`)
      .toArray()
      .map((row) => row.name),
  );
  if (!columns.has('decided_at')) {
    storage.sql.exec(`ALTER TABLE ${REFERENCE_TABLE} ADD COLUMN decided_at TEXT`);
  }
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${OPERATION_TABLE} (
      owner_scope_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT,
      saved_place_ref TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      PRIMARY KEY (owner_scope_ref, idempotency_key)
    )
  `);
};

const operationFor = (
  storage: DurableObjectStorage,
  ownerScopeRef: string,
  idempotencyKey: string,
): DecideOperationRow | undefined =>
  storage.sql
    .exec<DecideOperationRow>(
      `SELECT fingerprint, saved_place_ref, decided_at
         FROM ${OPERATION_TABLE}
        WHERE owner_scope_ref = ? AND idempotency_key = ?`,
      ownerScopeRef,
      idempotencyKey,
    )
    .toArray()[0];

export const decideDurableSavedReference = (
  storage: DurableObjectStorage,
  identity: DurableSavedReferenceStore,
  ownerScopeRef: string,
  input: OwnerDecideInput,
  options?: SavedReferenceOperationOptions,
): OwnerDecideResult => {
  initializeOwnerDecideStore(storage);
  const decidedAt = v.safeParse(IsoTimestampSchema, input.decidedAt);
  const registration = v.safeParse(SavedPlaceRegistrationSchema, {
    ownerScopeRef,
    provider: input.provider,
    recordRef: input.recordRef,
  });
  if (!decidedAt.success || !registration.success) return invalidInput;
  const idempotencyKey = parsedOperationKey(options);
  if (idempotencyKey === undefined) return invalidInput;
  const fingerprint = parsedFingerprint(options);
  if (fingerprint === undefined) return invalidInput;
  if (idempotencyKey === null && fingerprint !== null) return invalidInput;

  if (idempotencyKey !== null) {
    const prior = operationFor(storage, ownerScopeRef, idempotencyKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
      }
      const replay = identity.read(ownerScopeRef, prior.saved_place_ref);
      if (!replay.ok) return replay;
      if (replay.reference === null) return { ok: false, code: 'REFERENCE_CONFLICT' };
      return {
        ok: true,
        created: false,
        replayed: true,
        reference: replay.reference,
        decidedAt: prior.decided_at,
      };
    }
  }

  const registered = identity.register(
    {
      ownerScopeRef,
      provider: registration.output.provider,
      recordRef: registration.output.recordRef,
    },
    {},
  );
  if (!registered.ok) return registered;
  storage.sql.exec(
    `UPDATE ${REFERENCE_TABLE} SET decided_at = ? WHERE saved_place_ref = ? AND owner_scope_ref = ?`,
    decidedAt.output,
    registered.reference.savedPlaceRef,
    ownerScopeRef,
  );
  if (idempotencyKey !== null) {
    storage.sql.exec(
      `INSERT INTO ${OPERATION_TABLE}
         (owner_scope_ref, idempotency_key, fingerprint, saved_place_ref, decided_at)
       VALUES (?, ?, ?, ?, ?)`,
      ownerScopeRef,
      idempotencyKey,
      fingerprint,
      registered.reference.savedPlaceRef,
      decidedAt.output,
    );
  }
  return {
    ok: true,
    created: registered.created,
    replayed: false,
    reference: registered.reference,
    decidedAt: decidedAt.output,
  };
};
