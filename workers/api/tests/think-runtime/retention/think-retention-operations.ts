import * as v from 'valibot';
import { OpaqueIdSchema } from '@ima/core';
import {
  RETENTION_RESPONSE_TABLE,
  RETENTION_SAVED_TABLE,
  asNumber,
  asString,
  countSaved,
  ensureTables,
  nowOr,
  query,
  responseRow,
  runRetention,
  scrubError,
  statusFor,
  type RetentionOperation,
} from '../../runtime-gate/retention/retention-runtime';
import {
  installRetentionWriteAudit,
  readRetentionWriteAudit,
  resetRetentionWriteAudit,
  type RetentionAuditReport,
} from '../../runtime-gate/retention/retention-audit';
import type { ThinkRetentionSurface } from './think-retention-runtime';

export type ThinkRetentionOperation = RetentionOperation | 'compact' | 'inventory';

function tableCount(surface: ThinkRetentionSurface, table: string): number | null {
  try {
    const row = query(
      surface.storage.sql,
      `SELECT COUNT(*) AS count FROM "${table.replaceAll('"', '""')}"`,
    )[0];
    return asNumber(row, 'count') ?? null;
  } catch {
    return null;
  }
}

function tableInventory(surface: ThinkRetentionSurface, audit: RetentionAuditReport) {
  return {
    sessionMessages: tableCount(surface, 'assistant_messages'),
    compactions: tableCount(surface, 'assistant_compactions'),
    inventory: surface.inventory(audit),
  };
}

function reportBase(
  surface: ThinkRetentionSurface,
  audit: RetentionAuditReport,
  install: ReturnType<typeof installRetentionWriteAudit>,
) {
  return {
    audit,
    writeAudit: readRetentionWriteAudit(surface.storage.sql),
    writeAuditInstall: install,
    sdk: tableInventory(surface, audit),
    instanceToken: surface.instanceToken(),
    rawCanaryVisible: false as const,
  };
}

function responseOperation(
  operation: Extract<RetentionOperation, 'read' | 'replay' | 'recover' | 'display' | 'remodel'>,
  url: URL,
  surface: ThinkRetentionSurface,
): Response {
  const responseId = v.parse(
    OpaqueIdSchema,
    url.searchParams.get('responseId') ?? 'missing-response',
  );
  const owner = v.parse(OpaqueIdSchema, url.searchParams.get('owner') ?? 'owner-1');
  const at = nowOr(url.searchParams.get('at'), surface.clock.now());
  const rowValue = responseRow(surface, responseId);
  const storedOwner = asString(rowValue, 'owner_scope');
  if (storedOwner !== undefined && storedOwner !== owner) {
    return Response.json({ code: 'OWNER_MISMATCH', operation }, { status: 403 });
  }
  const state = statusFor(rowValue, at, operation);
  if (state.status !== 200) {
    return Response.json(
      { code: state.code, responseId, body: null, bodyResent: false, rawCanaryVisible: false },
      { status: state.status },
    );
  }
  const restoreMode = asString(rowValue, 'restore_mode') ?? 'reference_only';
  const body = restoreMode === 'full' ? (asString(rowValue, 'body') ?? null) : null;
  return Response.json({
    responseId,
    revision: asNumber(rowValue, 'revision') ?? 1,
    restoreMode,
    body,
    bodyResent: body !== null,
    sessionExpiresAt: asString(rowValue, 'session_expires_at'),
    freshUntil: asString(rowValue, 'fresh_until'),
    displayUntil: asString(rowValue, 'display_until'),
    retentionUntil: asString(rowValue, 'retention_until'),
    physicalDeleteAt: asString(rowValue, 'physical_delete_at'),
    operation,
    instanceToken: surface.instanceToken(),
    rawCanaryVisible: false,
  });
}

function savedOperation(
  operation: 'save' | 'saved' | 'saved-delete',
  url: URL,
  surface: ThinkRetentionSurface,
): Response {
  const owner = v.parse(OpaqueIdSchema, url.searchParams.get('owner') ?? 'owner-1');
  if (operation === 'saved') {
    const rows = query(
      surface.storage.sql,
      `SELECT saved_ref AS savedRef, response_id AS responseId FROM "${RETENTION_SAVED_TABLE}" WHERE owner_scope = ? ORDER BY saved_ref`,
      owner,
    );
    return Response.json({ savedCount: rows.length, savedRefs: rows, rawCanaryVisible: false });
  }
  const savedRef = v.parse(
    OpaqueIdSchema,
    url.searchParams.get('savedRef') ?? `saved-${crypto.randomUUID()}`,
  );
  if (operation === 'saved-delete') {
    const existing = query(
      surface.storage.sql,
      `SELECT owner_scope FROM "${RETENTION_SAVED_TABLE}" WHERE saved_ref = ?`,
      savedRef,
    )[0];
    if (existing === undefined) return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
    if (asString(existing, 'owner_scope') !== owner) {
      return Response.json({ code: 'OWNER_MISMATCH' }, { status: 403 });
    }
    surface.storage.sql.exec(
      `DELETE FROM "${RETENTION_SAVED_TABLE}" WHERE saved_ref = ?`,
      savedRef,
    );
    return Response.json({
      savedDeleted: true,
      savedCount: countSaved(surface, owner),
      rawCanaryVisible: false,
    });
  }
  const responseId = v.parse(
    OpaqueIdSchema,
    url.searchParams.get('responseId') ?? 'missing-response',
  );
  const rowValue = responseRow(surface, responseId);
  if (rowValue === undefined) return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
  if (asString(rowValue, 'owner_scope') !== owner) {
    return Response.json({ code: 'OWNER_MISMATCH' }, { status: 403 });
  }
  surface.storage.sql.exec(
    `INSERT OR IGNORE INTO "${RETENTION_SAVED_TABLE}"(saved_ref, owner_scope, response_id) VALUES (?, ?, ?)`,
    savedRef,
    owner,
    responseId,
  );
  return Response.json({
    saved: true,
    savedCount: countSaved(surface, owner),
    rawCanaryVisible: false,
  });
}

async function expireRetention(
  url: URL,
  surface: ThinkRetentionSurface,
  install: ReturnType<typeof installRetentionWriteAudit>,
): Promise<Response> {
  const owner = v.parse(OpaqueIdSchema, url.searchParams.get('owner') ?? 'owner-1');
  const at = nowOr(url.searchParams.get('at'), surface.clock.now());
  surface.clock.set(at);
  resetRetentionWriteAudit(surface.storage.sql);
  const before = await surface.audit();
  try {
    const rewrite = await surface.rewriteExpiredRetentionMessages(at);
    const after = await surface.audit();
    return Response.json({
      operation: 'expire',
      rewrite,
      ...reportBase(surface, after, install),
      persistenceBefore: before,
      persistenceAfter: after,
      savedCount: countSaved(surface, owner),
    });
  } catch (error) {
    const after = await surface.audit();
    return Response.json({
      operation: 'expire',
      code: scrubError(error),
      ...reportBase(surface, after, install),
      persistenceBefore: before,
      persistenceAfter: after,
      savedCount: countSaved(surface, owner),
    });
  }
}

async function compactRetention(
  url: URL,
  surface: ThinkRetentionSurface,
  install: ReturnType<typeof installRetentionWriteAudit>,
): Promise<Response> {
  const history = await surface.history();
  if (history.length < 1) return Response.json({ code: 'HISTORY_EMPTY' }, { status: 409 });
  const rawSummary = url.searchParams.get('summary') ?? 'untrusted provider compaction summary';
  resetRetentionWriteAudit(surface.storage.sql);
  const stored = await surface.compact(rawSummary);
  const audit = await surface.audit();
  return Response.json({
    operation: 'compact',
    compaction: {
      id: stored.id,
      summarySanitized: stored.summary === '[withheld]',
      summaryIsFixedPlaceholder: stored.summary === '[withheld]',
      fromMessageId: stored.fromMessageId,
      toMessageId: stored.toMessageId,
    },
    compactions: (await surface.compactions()).length,
    ...reportBase(surface, audit, install),
  });
}

function operationFromRequest(url: URL): ThinkRetentionOperation | undefined {
  const pathPart = url.pathname.split('/').filter(Boolean).at(-1);
  const selected =
    pathPart === 'replay'
      ? undefined
      : pathPart === 'run'
        ? url.searchParams.get('case')?.startsWith('retention-')
          ? 'run'
          : undefined
        : pathPart === 'retention'
          ? url.searchParams.get('op')
          : pathPart;
  const operations: readonly ThinkRetentionOperation[] = [
    'run',
    'persistence',
    'expire',
    'save',
    'saved',
    'saved-delete',
    'clear',
    'read',
    'replay',
    'recover',
    'display',
    'remodel',
    'sweep',
    'delete',
    'report',
    'compact',
    'inventory',
  ];
  return operations.find((operation) => operation === selected);
}

/** Dispatches the bounded retention routes against one actual Think DO. */
export async function handleThinkRetentionRequest(
  request: Request,
  surface: ThinkRetentionSurface,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const operation = operationFromRequest(url);
  if (operation === undefined) return undefined;
  if (request.method !== 'GET') return new Response('Not Found', { status: 404 });
  ensureTables(surface);
  const install = installRetentionWriteAudit(surface.storage.sql, [
    'M04_PROVIDER_QUOTE_CANARY',
    'M04_GENERATED_CANARY',
  ]);
  if (operation === 'run') return runRetention(url, surface, install);
  if (operation === 'expire') return expireRetention(url, surface, install);
  if (operation === 'compact') return compactRetention(url, surface, install);
  if (operation === 'persistence' || operation === 'report' || operation === 'inventory') {
    const audit = await surface.audit();
    return Response.json({ operation, ...reportBase(surface, audit, install) });
  }
  if (operation === 'save' || operation === 'saved' || operation === 'saved-delete') {
    return savedOperation(operation, url, surface);
  }
  if (operation === 'clear') {
    await surface.clearChat();
    const audit = await surface.audit();
    return Response.json({
      cleared: true,
      savedRows: tableCount(surface, RETENTION_SAVED_TABLE),
      ...reportBase(surface, audit, install),
    });
  }
  if (operation === 'sweep') {
    const at = nowOr(url.searchParams.get('at'), surface.clock.now());
    const expired = query(
      surface.storage.sql,
      `SELECT response_id FROM "${RETENTION_RESPONSE_TABLE}" WHERE physical_delete_at <= ?`,
      at,
    );
    if (expired.length > 0) await surface.clearChat();
    for (const row of expired) {
      const responseId = asString(row, 'response_id');
      if (responseId !== undefined) {
        surface.storage.sql.exec(
          `DELETE FROM "${RETENTION_RESPONSE_TABLE}" WHERE response_id = ?`,
          responseId,
        );
      }
    }
    const audit = await surface.audit();
    return Response.json({
      physicalDeleted: expired.length,
      savedRows: tableCount(surface, RETENTION_SAVED_TABLE),
      ...reportBase(surface, audit, install),
    });
  }
  if (
    operation === 'read' ||
    operation === 'replay' ||
    operation === 'recover' ||
    operation === 'display' ||
    operation === 'remodel'
  ) {
    return responseOperation(operation, url, surface);
  }
  if (operation === 'delete') {
    const responseId = v.parse(
      OpaqueIdSchema,
      url.searchParams.get('responseId') ?? 'missing-response',
    );
    const owner = v.parse(OpaqueIdSchema, url.searchParams.get('owner') ?? 'owner-1');
    const rowValue = responseRow(surface, responseId);
    if (rowValue === undefined) return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
    if (asString(rowValue, 'owner_scope') !== owner) {
      return Response.json({ code: 'OWNER_MISMATCH' }, { status: 403 });
    }
    await surface.clearChat();
    surface.storage.sql.exec(
      `DELETE FROM "${RETENTION_RESPONSE_TABLE}" WHERE response_id = ?`,
      responseId,
    );
    const audit = await surface.audit();
    return Response.json({
      deleted: true,
      savedRows: tableCount(surface, RETENTION_SAVED_TABLE),
      ...reportBase(surface, audit, install),
    });
  }
  return Response.json({ code: scrubError('RETENTION_OPERATION_UNHANDLED') }, { status: 500 });
}
