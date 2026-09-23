import * as v from 'valibot';
import { PreferencesSchema, type Preferences } from '@ima/contracts';
import type {
  OwnerPrefsPutResult,
  OwnerPrefsReadResult,
} from '@worker/application/ports/owner-store';

const TABLE_NAME = 'owner_prefs';
const PREFS_SINGLETON = 1;
const ExpectedRevisionSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const OwnerPrefsPutInputSchema = v.strictObject({
  prefs: PreferencesSchema,
  expectedRevision: ExpectedRevisionSchema,
});

export type OwnerPrefsStore = {
  readonly read: () => OwnerPrefsReadResult;
  readonly put: (input: unknown) => OwnerPrefsPutResult;
};

/** Walking and last-train columns written before #55; dropped on initialization. */
const LEGACY_TRAVEL_COLUMNS = ['home_station_ref', 'max_walk_minutes', 'minimum_stay_minutes'];

type PrefsRow = {
  readonly singleton: number;
  readonly revision: number;
  readonly area_text: string | null;
  readonly budget: string | null;
};

const invalidInput: { readonly ok: false; readonly code: 'INVALID_INPUT' } = {
  ok: false,
  code: 'INVALID_INPUT',
};

const prefsEqual = (left: Preferences, right: Preferences): boolean =>
  left.areaText === right.areaText && left.budget === right.budget;

const prefsFromRow = (row: PrefsRow): Preferences => {
  const parsed = v.safeParse(PreferencesSchema, {
    areaText: row.area_text,
    budget: row.budget,
  });
  if (!parsed.success) throw new Error('CORRUPT_ROW');
  return parsed.output;
};

const prefsRow = (storage: DurableObjectStorage): PrefsRow | undefined =>
  storage.sql
    .exec<PrefsRow>(
      `SELECT singleton, revision, area_text, budget
         FROM ${TABLE_NAME}
        WHERE singleton = ?`,
      PREFS_SINGLETON,
    )
    .toArray()[0];

const writePrefs = (storage: DurableObjectStorage, revision: number, prefs: Preferences): void => {
  storage.sql.exec(
    `INSERT OR REPLACE INTO ${TABLE_NAME} (singleton, revision, area_text, budget)
     VALUES (?, ?, ?, ?)`,
    PREFS_SINGLETON,
    revision,
    prefs.areaText,
    prefs.budget,
  );
};

export const initializeOwnerPrefsStore = (storage: DurableObjectStorage): void => {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL,
      area_text TEXT,
      budget TEXT
    )
  `);
  const columns = new Set(
    storage.sql
      .exec<{ readonly name: string }>(`SELECT name FROM pragma_table_info('${TABLE_NAME}')`)
      .toArray()
      .map((column) => column.name),
  );
  // Explicit migration: the stored values are discarded with the columns, and the revision is
  // kept so a client CAS against the current revision still succeeds.
  for (const column of LEGACY_TRAVEL_COLUMNS) {
    if (columns.has(column)) storage.sql.exec(`ALTER TABLE ${TABLE_NAME} DROP COLUMN ${column}`);
  }
};

/** Singleton prefs row for one owner shard. station_label is not persisted. */
export const createOwnerPrefsStore = (storage: DurableObjectStorage): OwnerPrefsStore => {
  initializeOwnerPrefsStore(storage);

  const read = (): OwnerPrefsReadResult => {
    const row = prefsRow(storage);
    if (row === undefined) return { ok: true, revision: 0, prefs: null };
    return { ok: true, revision: row.revision, prefs: prefsFromRow(row) };
  };

  const put = (input: unknown): OwnerPrefsPutResult => {
    const parsed = v.safeParse(OwnerPrefsPutInputSchema, input);
    if (!parsed.success) return invalidInput;
    const expectedRevision = parsed.output.expectedRevision;
    const prefs = parsed.output.prefs;
    return storage.transactionSync(() => {
      const row = prefsRow(storage);
      const currentRevision = row === undefined ? 0 : row.revision;
      const currentPrefs = row === undefined ? null : prefsFromRow(row);
      if (expectedRevision === currentRevision) {
        if (currentPrefs !== null && prefsEqual(currentPrefs, prefs)) {
          return { ok: true, revision: currentRevision, replayed: true };
        }
        const revision = currentRevision + 1;
        writePrefs(storage, revision, prefs);
        return { ok: true, revision, replayed: false };
      }
      if (
        expectedRevision === currentRevision - 1 &&
        currentPrefs !== null &&
        prefsEqual(currentPrefs, prefs)
      ) {
        return { ok: true, revision: currentRevision, replayed: true };
      }
      return { ok: false, code: 'REVISION_CONFLICT' };
    });
  };

  return { read, put };
};
