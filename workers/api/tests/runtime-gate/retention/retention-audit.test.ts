import { expect, it } from 'vitest';
import { auditRetentionSurface, type RetentionSqlReader } from './retention-audit';

const MARKERS = ['M04_SQL_CANARY'];

function fixtureSql(
  tables: Record<string, readonly Record<string, unknown>[]>,
  failures: ReadonlySet<string> = new Set(),
): RetentionSqlReader {
  return {
    exec(query) {
      if (query.includes("FROM sqlite_master WHERE type = 'table'")) {
        return { toArray: () => Object.keys(tables).map((name) => ({ name })) };
      }
      const match = /^SELECT \* FROM "((?:[^"]|"")*)"$/.exec(query);
      if (match === null) throw new Error(`unsupported fixture query: ${query}`);
      const tableName = match[1]?.replaceAll('""', '"');
      if (tableName === undefined || failures.has(tableName)) {
        throw new Error(`fixture read failed: ${tableName ?? 'unknown'}`);
      }
      return { toArray: () => tables[tableName] ?? [] };
    },
  };
}

it('distinguishes no SQL reader from an observed database with zero tables', async () => {
  const withoutSql = await auditRetentionSurface({ messages: [] }, MARKERS);
  expect(withoutSql.sql).toEqual({
    observed: false,
    readErrors: 0,
    tables: [],
    unobservedTables: [],
  });

  const emptyDatabase = await auditRetentionSurface({ messages: [], sql: fixtureSql({}) }, MARKERS);
  expect(emptyDatabase.sql).toEqual({
    observed: true,
    readErrors: 0,
    tables: [],
    unobservedTables: [
      { tableName: '_cf_KV', status: 'platform-owned', reason: 'not-publicly-readable' },
      { tableName: '_cf_METADATA', status: 'platform-owned', reason: 'not-publicly-readable' },
    ],
  });
});

it('keeps platform-owned tables unobserved and reports unknown table read failures', async () => {
  const report = await auditRetentionSurface(
    {
      messages: [],
      sql: fixtureSql(
        { _cf_KV: [], _cf_METADATA: [], assistant_messages: [], mystery_table: [] },
        new Set(['mystery_table']),
      ),
    },
    MARKERS,
  );

  expect(report.sql.observed).toBe(true);
  expect(report.sql.readErrors).toBe(1);
  expect(report.sql.unobservedTables).toEqual([
    { tableName: '_cf_KV', status: 'platform-owned', reason: 'not-publicly-readable' },
    { tableName: '_cf_METADATA', status: 'platform-owned', reason: 'not-publicly-readable' },
  ]);
  expect(report.sql.tables).toEqual([
    { tableName: 'assistant_messages', kind: 'messages', rowCount: 0, forbiddenRows: 0 },
    { tableName: 'mystery_table', kind: 'other', rowCount: null, forbiddenRows: 0 },
  ]);
});

it('keeps a failed table read distinct from a successful zero-row read', async () => {
  const report = await auditRetentionSurface(
    {
      messages: [],
      sql: fixtureSql(
        {
          assistant_messages: [],
          cf_ai_chat_stream_chunks: [{ body: MARKERS[0] }],
        },
        new Set(['assistant_messages']),
      ),
    },
    MARKERS,
  );

  expect(report.sql.readErrors).toBe(1);
  expect(report.sql.tables).toEqual([
    { tableName: 'assistant_messages', kind: 'messages', rowCount: null, forbiddenRows: 0 },
    {
      tableName: 'cf_ai_chat_stream_chunks',
      kind: 'stream',
      rowCount: 1,
      forbiddenRows: 1,
    },
  ]);
});
