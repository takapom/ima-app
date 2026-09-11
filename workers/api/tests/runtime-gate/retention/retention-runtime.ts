import type { UIMessage } from 'ai';
import type { SaveMessagesResult } from '@cloudflare/ai-chat';
import * as v from 'valibot';
import { IsoTimestampSchema, OpaqueIdSchema } from '@ima/core';
import {
  installRetentionWriteAudit,
  readRetentionWriteAudit,
  resetRetentionWriteAudit,
  type RetentionAuditReport,
  type RetentionSqlReader,
  type RetentionWriteAuditInstallReport,
  type RetentionWriteAuditReport,
} from '../../support/retention-audit';
import {
  auditCurrentRetentionSurface,
  makeRetentionMessage,
  rewriteExpiredMessages,
  type RetentionPublicRuntimeSurface,
  type RetentionRewriteReport,
} from './retention-fixture';
import type {
  RetentionOperation,
  RetentionRuntimeReport,
  RetentionRuntimeSurface,
} from './retention-runtime-contract';
import { plusMinutes, policyOf, retentionFor } from './retention-runtime-policy';

export type {
  RetentionOperation,
  RetentionPolicy,
  RetentionRuntimeContext,
  RetentionRuntimeReport,
  RetentionRuntimeStorage,
  RetentionRuntimeSurface,
} from './retention-runtime-contract';

export { plusMinutes, policyOf, retentionFor, sessionExpiry } from './retention-runtime-policy';

export const RETENTION_MARKERS: readonly string[] = [
  'M04_PROVIDER_QUOTE_CANARY',
  'M04_GENERATED_CANARY',
];
export const RETENTION_RESPONSE_TABLE = 'retention_runtime_responses';
export const RETENTION_SAVED_TABLE = 'retention_runtime_saved_refs';

type SqlRow = Record<string, unknown>;

export function query(
  sql: RetentionSqlReader,
  statement: string,
  ...bindings: unknown[]
): readonly SqlRow[] {
  return sql.exec(statement, ...bindings).toArray();
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function asString(row: SqlRow | undefined, key: string): string | undefined {
  const value = row?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(row: SqlRow | undefined, key: string): number | undefined {
  const value = row?.[key];
  return typeof value === 'number' ? value : undefined;
}

export function nowOr(value: string | null, fallback: string): string {
  return v.parse(IsoTimestampSchema, value ?? fallback);
}

export function runtimePersistence(
  surface: RetentionRuntimeSurface,
): RetentionPublicRuntimeSurface {
  return {
    readMessages: () => surface.messages,
    persistMessages: (messages) => surface.persistMessages(messages),
    storage: surface.storage,
    sql: surface.storage.sql,
  };
}

export function installAudit(surface: RetentionRuntimeSurface): RetentionWriteAuditInstallReport {
  return installRetentionWriteAudit(surface.storage.sql, RETENTION_MARKERS);
}

export async function audit(surface: RetentionRuntimeSurface): Promise<RetentionAuditReport> {
  return auditCurrentRetentionSurface(runtimePersistence(surface), RETENTION_MARKERS);
}

export function writeAudit(surface: RetentionRuntimeSurface): RetentionWriteAuditReport {
  return readRetentionWriteAudit(surface.storage.sql);
}

export function ensureTables(surface: RetentionRuntimeSurface): void {
  const sql = surface.storage.sql;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ${quoteIdentifier(RETENTION_RESPONSE_TABLE)} (
      response_id TEXT PRIMARY KEY,
      owner_scope TEXT NOT NULL,
      policy TEXT NOT NULL,
      created_at TEXT NOT NULL,
      session_expires_at TEXT NOT NULL,
      fresh_until TEXT,
      display_until TEXT,
      retention_until TEXT,
      physical_delete_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      restore_mode TEXT NOT NULL,
      body TEXT
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ${quoteIdentifier(RETENTION_SAVED_TABLE)} (
      saved_ref TEXT PRIMARY KEY,
      owner_scope TEXT NOT NULL,
      response_id TEXT NOT NULL
    )
  `);
}

export function countSaved(surface: RetentionRuntimeSurface, owner: string): number {
  return Number(
    asNumber(
      query(
        surface.storage.sql,
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(RETENTION_SAVED_TABLE)} WHERE owner_scope = ?`,
        owner,
      )[0],
      'count',
    ) ?? 0,
  );
}

export function countRows(surface: RetentionRuntimeSurface, table: string): number {
  return Number(
    asNumber(
      query(surface.storage.sql, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`)[0],
      'count',
    ) ?? 0,
  );
}

export function responseRow(
  surface: RetentionRuntimeSurface,
  responseId: string,
): SqlRow | undefined {
  return query(
    surface.storage.sql,
    `SELECT * FROM ${quoteIdentifier(RETENTION_RESPONSE_TABLE)} WHERE response_id = ?`,
    responseId,
  )[0];
}

export function ownerMismatch(row: SqlRow | undefined, owner: string): boolean {
  const storedOwner = asString(row, 'owner_scope');
  return storedOwner !== undefined && storedOwner !== owner;
}

export function statusFor(
  row: SqlRow | undefined,
  at: string,
  operation: RetentionOperation,
): { status: number; code: string | null } {
  if (row === undefined) return { status: 404, code: 'NOT_FOUND' };
  const physicalDeleteAt = asString(row, 'physical_delete_at');
  const sessionExpiresAt = asString(row, 'session_expires_at');
  if (physicalDeleteAt !== undefined && Date.parse(at) >= Date.parse(physicalDeleteAt)) {
    return {
      status: 410,
      code: physicalDeleteAt === sessionExpiresAt ? 'EXPIRED' : 'PHYSICALLY_DELETED',
    };
  }
  if (sessionExpiresAt !== undefined && Date.parse(at) >= Date.parse(sessionExpiresAt)) {
    return { status: 410, code: 'EXPIRED' };
  }
  const retentionUntil = asString(row, 'retention_until');
  if (
    operation !== 'display' &&
    retentionUntil !== undefined &&
    Date.parse(at) >= Date.parse(retentionUntil)
  ) {
    return { status: 410, code: 'RETENTION_EXPIRED' };
  }
  const freshUntil = asString(row, 'fresh_until');
  if (
    operation === 'remodel' &&
    freshUntil !== undefined &&
    Date.parse(at) >= Date.parse(freshUntil)
  ) {
    return { status: 409, code: 'FRESHNESS_EXPIRED' };
  }
  const displayUntil = asString(row, 'display_until');
  if (displayUntil !== undefined && Date.parse(at) >= Date.parse(displayUntil)) {
    return { status: 410, code: 'DISPLAY_EXPIRED' };
  }
  return { status: 200, code: null };
}

export function scrubError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return RETENTION_MARKERS.reduce(
    (result, marker) => result.replaceAll(marker, '[withheld]'),
    text,
  );
}

export async function runRetention(
  url: URL,
  surface: RetentionRuntimeSurface,
  install: RetentionWriteAuditInstallReport,
): Promise<Response> {
  const owner = v.parse(OpaqueIdSchema, url.searchParams.get('owner') ?? 'owner-1');
  const threadId = v.parse(OpaqueIdSchema, url.searchParams.get('thread') ?? 'thread-1');
  const turnId = v.parse(
    OpaqueIdSchema,
    url.searchParams.get('turn') ?? `turn-${crypto.randomUUID()}`,
  );
  const createdAt = nowOr(url.searchParams.get('createdAt'), surface.clock.now());
  const policy = policyOf(url.searchParams.get('policy'));
  const explicitExpiry = url.searchParams.get('expiresAt');
  const retention = retentionFor(policy, createdAt, explicitExpiry);
  const markerText =
    url.searchParams.get('payload') === 'safe'
      ? 'safe user input'
      : `user ${RETENTION_MARKERS[0]} ${crypto.randomUUID()}`;
  surface.setRetentionContext({
    ownerScopeRef: owner,
    threadId,
    turnId,
    now: createdAt,
    retention,
    policy,
  });
  surface.setRetentionScenario(policy);
  surface.clock.set(createdAt);
  resetRetentionWriteAudit(surface.storage.sql);
  const before = await audit(surface);
  const userMessage = makeRetentionMessage({
    id: `retention-user-${turnId}`,
    role: 'user',
    text: markerText,
    ownerScopeRef: owner,
    threadId,
    turnId,
    retention,
  });
  const poisoned: UIMessage = {
    id: userMessage.id,
    role: userMessage.role,
    parts: [...userMessage.parts, { type: 'data-retention-canary', data: RETENTION_MARKERS[1] }],
    metadata: { ...userMessage.metadata, runtimeCanary: RETENTION_MARKERS[1] },
  };
  const controller = policy === 'disconnect' ? new AbortController() : undefined;
  const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), 40);
  let result: SaveMessagesResult | undefined;
  let error: string | null = null;
  try {
    result = await surface.saveMessages(
      [poisoned],
      controller === undefined ? undefined : { signal: controller.signal },
    );
  } catch (value) {
    error = scrubError(value);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const responseId = `retention-response-${crypto.randomUUID()}`;
  if (result?.status === 'completed') {
    const physicalDeleteAt =
      policy === 'allow' ? plusMinutes(createdAt, 16) : retention.sessionExpiresAt;
    surface.storage.sql.exec(
      `INSERT OR REPLACE INTO ${quoteIdentifier(RETENTION_RESPONSE_TABLE)}
       (response_id, owner_scope, policy, created_at, session_expires_at, fresh_until,
        display_until, retention_until, physical_delete_at, revision, restore_mode, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      responseId,
      owner,
      policy,
      createdAt,
      retention.sessionExpiresAt,
      retention.freshUntil,
      retention.displayUntil,
      retention.retentionUntil,
      physicalDeleteAt,
      1,
      retention.restoreMode,
      policy === 'allow' ? 'ALLOW_BODY' : null,
    );
  }
  const after = await audit(surface);
  const report: RetentionRuntimeReport = {
    operation: 'run',
    result: result
      ? { status: result.status, error: result.error ? scrubError(result.error) : error }
      : { status: 'error', error },
    responseId: result?.status === 'completed' ? responseId : null,
    turnId,
    persistenceBefore: before,
    persistenceAfter: after,
    writeAudit: writeAudit(surface),
    writeAuditInstall: install,
    savedCount: countSaved(surface, owner),
    instanceToken: surface.instanceToken(),
    rawCanaryVisible: false,
  };
  return Response.json(report);
}

export async function expireRetention(
  url: URL,
  surface: RetentionRuntimeSurface,
  install: RetentionWriteAuditInstallReport,
): Promise<Response> {
  const owner = v.parse(OpaqueIdSchema, url.searchParams.get('owner') ?? 'owner-1');
  const at = nowOr(url.searchParams.get('at'), surface.clock.now());
  surface.clock.set(at);
  resetRetentionWriteAudit(surface.storage.sql);
  const before = await audit(surface);
  let rewrite: RetentionRewriteReport;
  try {
    rewrite = await rewriteExpiredMessages(
      runtimePersistence(surface),
      surface.clock,
      at,
      RETENTION_MARKERS,
    );
  } catch (value) {
    return Response.json({
      operation: 'expire',
      code: scrubError(value),
      persistenceBefore: before,
      persistenceAfter: await audit(surface),
      writeAudit: writeAudit(surface),
      writeAuditInstall: install,
      savedCount: countSaved(surface, owner),
      rawCanaryVisible: false,
    });
  }
  return Response.json({
    operation: 'expire',
    rewrite,
    persistenceBefore: before,
    persistenceAfter: await audit(surface),
    writeAudit: writeAudit(surface),
    writeAuditInstall: install,
    savedCount: countSaved(surface, owner),
    rawCanaryVisible: false,
  });
}
