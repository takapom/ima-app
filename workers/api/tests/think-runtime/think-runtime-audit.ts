export type ThinkRuntimeTableObservation = {
  observed: boolean;
  readError: string | null;
  markerCount: number;
};

type SqlRow = Record<string, unknown>;
type SqlCursor = { toArray(): readonly SqlRow[] };
type SqlReader = { exec(query: string): SqlCursor };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function hasMarker(value: unknown, marker: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return value.includes(marker);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => hasMarker(child, marker, seen));
}

/** Observe every table explicitly; a failed read is never reported as zero. */
export function markerRowsByTable(
  sql: SqlReader,
  marker: string,
): Record<string, ThinkRuntimeTableObservation> {
  const observations: Record<string, ThinkRuntimeTableObservation> = {};
  let tables: readonly SqlRow[];
  try {
    tables = sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .toArray();
  } catch (error) {
    observations.sqlite_master = { observed: false, readError: errorText(error), markerCount: 0 };
    return observations;
  }

  for (const row of tables) {
    const name = row.name;
    if (typeof name !== 'string') continue;
    try {
      const rows = sql.exec(`SELECT * FROM ${quoteIdentifier(name)}`).toArray();
      observations[name] = {
        observed: true,
        readError: null,
        markerCount: rows.filter((candidate) => hasMarker(candidate, marker)).length,
      };
    } catch (error) {
      observations[name] = { observed: false, readError: errorText(error), markerCount: 0 };
    }
  }
  return observations;
}
