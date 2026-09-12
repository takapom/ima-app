import * as v from 'valibot';
import { IsoTimestampSchema, SavedPlaceReferenceSchema, type SavedPlaceReference } from '@ima/core';
import type { OwnerDecidedPlace } from './owner-store';
import { initializeOwnerDecideStore } from './decide-store';

const TABLE_NAME = 'm16_saved_place_reference';
const MAX_SAVED_LIST = 50;

type ReferenceRow = {
  readonly saved_place_ref: string;
  readonly owner_scope_ref: string;
  readonly provider: string;
  readonly record_ref: string;
  readonly decided_at: string | null;
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

export type DurableSavedList = {
  readonly references: readonly SavedPlaceReference[];
  readonly decided: readonly OwnerDecidedPlace[];
};

/** Owner identity rows only. A corrupt row fails the list instead of being skipped. */
export const listDurableSavedReferences = (
  storage: DurableObjectStorage,
  ownerScopeRef: string,
): DurableSavedList => {
  initializeOwnerDecideStore(storage);
  const rows = storage.sql
    .exec<ReferenceRow>(
      `SELECT saved_place_ref, owner_scope_ref, provider, record_ref, decided_at
         FROM ${TABLE_NAME}
        WHERE owner_scope_ref = ?
        ORDER BY rowid
        LIMIT ?`,
      ownerScopeRef,
      MAX_SAVED_LIST,
    )
    .toArray();
  const references = rows.map(referenceFromRow);
  const decided = rows.flatMap((row) => {
    if (row.decided_at === null) return [];
    const parsed = v.safeParse(IsoTimestampSchema, row.decided_at);
    if (!parsed.success) throw new Error('CORRUPT_ROW');
    return [{ savedPlaceRef: row.saved_place_ref, decidedAt: parsed.output }];
  });
  return { references, decided };
};
