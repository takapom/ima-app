import * as v from 'valibot';
import { SavedPlaceReferenceSchema, type SavedPlaceReference } from '@ima/core';

const TABLE_NAME = 'm16_saved_place_reference';
const MAX_SAVED_LIST = 50;

type ReferenceRow = {
  readonly saved_place_ref: string;
  readonly owner_scope_ref: string;
  readonly provider: string;
  readonly record_ref: string;
};

const referenceFromRow = (row: ReferenceRow): SavedPlaceReference => {
  const parsed = v.safeParse(SavedPlaceReferenceSchema, {
    savedPlaceRef: row.saved_place_ref,
    ownerScopeRef: row.owner_scope_ref,
    provider: row.provider,
    recordRef: row.record_ref,
  });
  if (!parsed.success) throw new Error('CORRUPT_ROW');
  return parsed.output;
};

/** Owner identity rows only. A corrupt row fails the list instead of being skipped. */
export const listDurableSavedReferences = (
  storage: DurableObjectStorage,
  ownerScopeRef: string,
): readonly SavedPlaceReference[] =>
  storage.sql
    .exec<ReferenceRow>(
      `SELECT saved_place_ref, owner_scope_ref, provider, record_ref
         FROM ${TABLE_NAME}
        WHERE owner_scope_ref = ?
        ORDER BY rowid
        LIMIT ?`,
      ownerScopeRef,
      MAX_SAVED_LIST,
    )
    .toArray()
    .map(referenceFromRow);
