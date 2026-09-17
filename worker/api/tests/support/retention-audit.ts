import type { UIMessage } from 'ai';
import { parseRetentionMessage } from './retention-policy';

/** Test-only marker observation. The value and the matched payload are never returned. */
export type RetentionForbiddenObservation = {
  hasForbidden: boolean;
  markerMatches: number;
};

export type RetentionStorageReader = {
  list(): Promise<ReadonlyMap<string, unknown>>;
  get<T>(key: string): Promise<T | undefined>;
};

export type RetentionSqlResult = {
  toArray(): readonly Record<string, unknown>[];
};

/** Optional adapter for a public SQL reader supplied by the runtime fixture. */
export type RetentionSqlReader = {
  exec(query: string, ...bindings: unknown[]): RetentionSqlResult;
};

export type RetentionAuditSurface = {
  messages: readonly UIMessage[];
  storage?: RetentionStorageReader;
  sql?: RetentionSqlReader;
};

export type RetentionMessageObservation = RetentionForbiddenObservation & {
  id: string;
  referenceOnly: boolean;
  textIsReferenceOnly: boolean;
};

export type RetentionTableKind = 'messages' | 'stream' | 'compaction' | 'kv' | 'other';

export type RetentionTableObservation = {
  tableName: string;
  kind: RetentionTableKind;
  rowCount: number | null;
  forbiddenRows: number;
};

export type RetentionSqlUnobservedTable = {
  tableName: '_cf_KV' | '_cf_METADATA';
  status: 'platform-owned';
  reason: 'not-publicly-readable';
};

export type RetentionAuditReport = {
  messages: {
    entries: number;
    forbiddenEntries: number;
    referenceOnlyEntries: number;
    observations: readonly RetentionMessageObservation[];
  };
  storage: {
    observed: boolean;
    writeObservation: 'after-read-only';
    entries: number;
    forbiddenEntries: number;
    getReads: number;
    readErrors: number;
  };
  sql: {
    observed: boolean;
    readErrors: number;
    tables: readonly RetentionTableObservation[];
    unobservedTables: readonly RetentionSqlUnobservedTable[];
  };
};

export type RetentionWriteAuditInstallReport = {
  observed: boolean;
  readErrors: number;
  installErrors: number;
  unobservedTables: readonly RetentionSqlUnobservedTable[];
};

export type RetentionWriteAuditReport = {
  observed: boolean;
  readErrors: number;
  forbiddenWrites: number;
  auditRows: number | null;
};

const WRITE_OPERATIONS: readonly ('INSERT' | 'UPDATE' | 'DELETE')[] = [
  'INSERT',
  'UPDATE',
  'DELETE',
];

const UNOBSERVED_SQL_TABLES: readonly RetentionSqlUnobservedTable[] = [
  {
    tableName: '_cf_KV',
    status: 'platform-owned',
    reason: 'not-publicly-readable',
  },
  {
    tableName: '_cf_METADATA',
    status: 'platform-owned',
    reason: 'not-publicly-readable',
  },
];

function isUnobservedSqlTable(tableName: string): tableName is '_cf_KV' | '_cf_METADATA' {
  return tableName === '_cf_KV' || tableName === '_cf_METADATA';
}

function nonEmptyMarkers(markers: readonly string[]): readonly string[] {
  return markers.filter((marker) => marker.length > 0);
}

function markerMatches(value: string, markers: readonly string[]): number {
  return markers.reduce((count, marker) => count + (value.includes(marker) ? 1 : 0), 0);
}

function objectValues(value: object): readonly unknown[] {
  const values: unknown[] = [];
  for (const key of Object.keys(value)) {
    values.push(Reflect.get(value, key));
  }
  return values;
}

/** Recursively inspect serializable values while keeping only marker counts. */
export function observeForbiddenValue(
  value: unknown,
  markers: readonly string[],
): RetentionForbiddenObservation {
  const activeMarkers = nonEmptyMarkers(markers);
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown): number => {
    if (typeof candidate === 'string') return markerMatches(candidate, activeMarkers);
    if (candidate === null || typeof candidate !== 'object') return 0;
    if (seen.has(candidate)) return 0;
    seen.add(candidate);
    const children: readonly unknown[] = Array.isArray(candidate)
      ? candidate
      : objectValues(candidate);
    let count = 0;
    for (const child of children) count += visit(child);
    return count;
  };

  const markerCount = visit(value);
  return { hasForbidden: markerCount > 0, markerMatches: markerCount };
}

export function observeRetentionMessage(
  message: UIMessage,
  markers: readonly string[],
): RetentionMessageObservation {
  const forbidden = observeForbiddenValue(message, markers);
  const parsed = parseRetentionMessage(message);
  const firstPart = message.parts[0];
  return {
    id: message.id,
    ...forbidden,
    referenceOnly: parsed?.metadata.retention.restoreMode === 'reference_only',
    textIsReferenceOnly:
      message.parts.length === 1 && firstPart?.type === 'text' && firstPart.text === '[withheld]',
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function tableKind(tableName: string): RetentionTableKind {
  const normalized = tableName.toLowerCase();
  if (normalized.includes('message')) return 'messages';
  if (normalized.includes('stream')) return 'stream';
  if (normalized.includes('compact')) return 'compaction';
  if (normalized.includes('kv')) return 'kv';
  return 'other';
}

function readSql(
  reader: RetentionSqlReader,
  query: string,
): { rows: readonly Record<string, unknown>[] } | { error: true } {
  try {
    return { rows: reader.exec(query).toArray() };
  } catch {
    return { error: true };
  }
}

function tableNames(sql: RetentionSqlReader): readonly string[] | undefined {
  const result = readSql(
    sql,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  if ('error' in result) return undefined;
  return result.rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : []));
}

function tableColumns(sql: RetentionSqlReader, tableName: string): readonly string[] | undefined {
  const result = readSql(sql, `PRAGMA table_info(${quoteIdentifier(tableName)})`);
  if ('error' in result) return undefined;
  return result.rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : []));
}

function forbiddenExpression(
  columns: readonly string[],
  rowAlias: string,
  markers: readonly string[],
): string {
  const expressions = markers.flatMap((marker) =>
    columns.map(
      (column) =>
        `instr(COALESCE(CAST(${rowAlias}.${quoteIdentifier(column)} AS TEXT), ''), ${quoteLiteral(marker)}) > 0`,
    ),
  );
  return expressions.length > 0 ? expressions.join(' OR ') : '0';
}

/** Fixture-only BEFORE triggers; production persistence remains SDK-owned. */
export function installRetentionWriteAudit(
  sql: RetentionSqlReader,
  markers: readonly string[],
): RetentionWriteAuditInstallReport {
  const auditTable = quoteIdentifier('retention_write_audit');
  try {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS ${auditTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        saw_forbidden INTEGER NOT NULL
      )
    `);
  } catch {
    return {
      observed: false,
      readErrors: 1,
      installErrors: 1,
      unobservedTables: UNOBSERVED_SQL_TABLES,
    };
  }
  const names = tableNames(sql);
  if (names === undefined) {
    return {
      observed: false,
      readErrors: 1,
      installErrors: 0,
      unobservedTables: UNOBSERVED_SQL_TABLES,
    };
  }
  let installErrors = 0;
  let readErrors = 0;
  for (const tableName of names) {
    if (isUnobservedSqlTable(tableName)) continue;
    if (tableName === 'retention_write_audit' || tableName.startsWith('retention_')) continue;
    const columns = tableColumns(sql, tableName);
    if (columns === undefined) {
      readErrors += 1;
      continue;
    }
    for (const operation of WRITE_OPERATIONS) {
      const rowAlias = operation === 'DELETE' ? 'OLD' : 'NEW';
      const triggerName = quoteIdentifier(
        `retention_${tableName}_${operation}`.replaceAll(/[^A-Za-z0-9_]/g, '_').slice(0, 180),
      );
      try {
        sql.exec(`
          CREATE TRIGGER IF NOT EXISTS ${triggerName}
          BEFORE ${operation} ON ${quoteIdentifier(tableName)}
          BEGIN
            INSERT INTO ${auditTable}(table_name, operation, saw_forbidden)
            VALUES (${quoteLiteral(tableName)}, ${quoteLiteral(operation)},
              CASE WHEN ${forbiddenExpression(columns, rowAlias, markers)} THEN 1 ELSE 0 END);
          END
        `);
      } catch {
        installErrors += 1;
      }
    }
  }
  return { observed: true, readErrors, installErrors, unobservedTables: UNOBSERVED_SQL_TABLES };
}

/** Remove only fixture audit rows; it does not touch SDK-owned tables. */
export function resetRetentionWriteAudit(sql: RetentionSqlReader): boolean {
  try {
    sql.exec('DELETE FROM "retention_write_audit"');
    return true;
  } catch {
    return false;
  }
}

/** Read marker-only BEFORE-trigger evidence; inaccessible platform KV stays unobserved. */
export function readRetentionWriteAudit(sql: RetentionSqlReader): RetentionWriteAuditReport {
  const rows = readSql(
    sql,
    'SELECT table_name, operation, COUNT(*) AS count FROM "retention_write_audit" WHERE saw_forbidden = 1 GROUP BY table_name, operation',
  );
  const total = readSql(sql, 'SELECT COUNT(*) AS count FROM "retention_write_audit"');
  if ('error' in rows || 'error' in total) {
    return { observed: false, readErrors: 1, forbiddenWrites: 0, auditRows: null };
  }
  const forbiddenWrites = rows.rows.reduce((count, row) => {
    const value = row.count;
    return typeof value === 'number' ? count + value : count;
  }, 0);
  const auditRows = total.rows[0]?.count;
  return {
    observed: true,
    readErrors: 0,
    forbiddenWrites,
    auditRows: typeof auditRows === 'number' ? auditRows : null,
  };
}

async function auditStorage(
  storage: RetentionStorageReader | undefined,
  markers: readonly string[],
): Promise<RetentionAuditReport['storage']> {
  if (storage === undefined) {
    return {
      observed: false,
      writeObservation: 'after-read-only',
      entries: 0,
      forbiddenEntries: 0,
      getReads: 0,
      readErrors: 0,
    };
  }

  let listed: ReadonlyMap<string, unknown>;
  try {
    listed = await storage.list();
  } catch {
    return {
      observed: false,
      writeObservation: 'after-read-only',
      entries: 0,
      forbiddenEntries: 0,
      getReads: 0,
      readErrors: 1,
    };
  }

  let forbiddenEntries = 0;
  let getReads = 0;
  let readErrors = 0;
  for (const [key, listedValue] of listed) {
    const keyObservation = observeForbiddenValue(key, markers);
    const listedObservation = observeForbiddenValue(listedValue, markers);
    let forbidden = keyObservation.hasForbidden || listedObservation.hasForbidden;
    try {
      const currentValue = await storage.get<unknown>(key);
      getReads += 1;
      forbidden = forbidden || observeForbiddenValue(currentValue, markers).hasForbidden;
    } catch {
      readErrors += 1;
    }
    if (forbidden) forbiddenEntries += 1;
  }
  return {
    observed: true,
    writeObservation: 'after-read-only',
    entries: listed.size,
    forbiddenEntries,
    getReads,
    readErrors,
  };
}

function auditSql(
  sql: RetentionSqlReader | undefined,
  markers: readonly string[],
): RetentionAuditReport['sql'] {
  if (sql === undefined) {
    return { observed: false, readErrors: 0, tables: [], unobservedTables: [] };
  }
  const tableResult = readSql(
    sql,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  if ('error' in tableResult) {
    return { observed: false, readErrors: 1, tables: [], unobservedTables: UNOBSERVED_SQL_TABLES };
  }

  const tables: RetentionTableObservation[] = [];
  let readErrors = 0;
  for (const row of tableResult.rows) {
    const tableName = row.name;
    if (typeof tableName !== 'string') continue;
    if (isUnobservedSqlTable(tableName)) continue;
    const tableResultForRows = readSql(sql, `SELECT * FROM ${quoteIdentifier(tableName)}`);
    if ('error' in tableResultForRows) {
      readErrors += 1;
      tables.push({
        tableName,
        kind: tableKind(tableName),
        rowCount: null,
        forbiddenRows: 0,
      });
      continue;
    }
    const forbiddenRows = tableResultForRows.rows.filter(
      (tableRow) => observeForbiddenValue(tableRow, markers).hasForbidden,
    ).length;
    tables.push({
      tableName,
      kind: tableKind(tableName),
      rowCount: tableResultForRows.rows.length,
      forbiddenRows,
    });
  }
  return { observed: true, readErrors, tables, unobservedTables: UNOBSERVED_SQL_TABLES };
}

/** Read-only diagnostics for messages, public KV, and an explicitly supplied public SQL view. */
export async function auditRetentionSurface(
  surface: RetentionAuditSurface,
  markers: readonly string[],
): Promise<RetentionAuditReport> {
  const observations = surface.messages.map((message) => observeRetentionMessage(message, markers));
  const storage = await auditStorage(surface.storage, markers);
  const sql = auditSql(surface.sql, markers);
  return {
    messages: {
      entries: observations.length,
      forbiddenEntries: observations.filter((entry) => entry.hasForbidden).length,
      referenceOnlyEntries: observations.filter((entry) => entry.referenceOnly).length,
      observations,
    },
    storage,
    sql,
  };
}
