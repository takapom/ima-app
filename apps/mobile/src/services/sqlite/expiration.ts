import { iso } from './rows';
import type { SqliteConnection, SqliteClock, SqliteStoreOptions } from './types';

export const currentIso = (clock: SqliteClock): string => {
  const value = iso(clock.now());
  if (value === null) throw new Error('SQLITE_INVALID_CLOCK');
  return value;
};

export const cleanupExpiredRows = (
  database: SqliteConnection,
  options: Pick<SqliteStoreOptions, 'clock'>,
): void => {
  const now = currentIso(options.clock);
  database
    .prepare(
      `UPDATE saved_place
       SET name = NULL, area = NULL,
           restore_mode = CASE WHEN server_saved_place_ref IS NULL THEN 'unavailable' ELSE 'reference_only' END,
           needs_refetch = 1
       WHERE restore_mode = 'full'
         AND (session_expires_at <= ? OR display_until <= ? OR retention_until <= ? OR deletion_scheduled_at <= ?)`,
    )
    .run(now, now, now, now);
  database
    .prepare(
      `DELETE FROM thread_snapshot
       WHERE session_expires_at <= ? OR display_until <= ? OR retention_until <= ? OR deletion_scheduled_at <= ?`,
    )
    .run(now, now, now, now);
  database.prepare('DELETE FROM skip_tonight WHERE expires_at <= ?').run(now);
  database.prepare('DELETE FROM thread WHERE expires_at <= ?').run(now);
};
