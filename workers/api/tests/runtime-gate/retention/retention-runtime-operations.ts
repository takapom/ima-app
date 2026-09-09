import * as v from 'valibot';
import { OpaqueIdSchema } from '@ima/core';
import {
  RETENTION_RESPONSE_TABLE,
  RETENTION_SAVED_TABLE,
  asNumber,
  asString,
  audit,
  countRows,
  countSaved,
  ensureTables,
  expireRetention,
  installAudit,
  nowOr,
  query,
  responseRow,
  runRetention,
  scrubError,
  statusFor,
  writeAudit,
} from './retention-runtime';
import type { RetentionOperation, RetentionRuntimeSurface } from './retention-runtime';
import { isRetentionExpired, parseRetentionMessage } from './retention-policy';

function responseOperation(
  operation: Extract<RetentionOperation, 'read' | 'replay' | 'recover' | 'display' | 'remodel'>,
  url: URL,
  surface: RetentionRuntimeSurface,
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
  surface: RetentionRuntimeSurface,
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

async function sweepRetention(url: URL, surface: RetentionRuntimeSurface): Promise<Response> {
  const at = nowOr(url.searchParams.get('at'), surface.clock.now());
  const expired = query(
    surface.storage.sql,
    `SELECT response_id FROM "${RETENTION_RESPONSE_TABLE}"
     WHERE julianday(physical_delete_at) <= julianday(?)`,
    at,
  );
  if (expired.length > 0) {
    const activeMessages = surface.messages.filter((message) => {
      const parsed = parseRetentionMessage(message);
      return parsed === undefined || !isRetentionExpired(parsed.metadata, at);
    });
    await surface.clearChat();
    await surface.persistMessages(activeMessages);
  }
  for (const rowValue of expired) {
    const responseId = asString(rowValue, 'response_id');
    if (responseId !== undefined) {
      surface.storage.sql.exec(
        `DELETE FROM "${RETENTION_RESPONSE_TABLE}" WHERE response_id = ?`,
        responseId,
      );
    }
  }
  return Response.json({
    physicalDeleted: expired.length,
    sdkHistoryRows: countRows(surface, 'cf_ai_chat_agent_messages'),
    sdkStreamRows: countRows(surface, 'cf_ai_chat_stream_chunks'),
    savedRows: countRows(surface, RETENTION_SAVED_TABLE),
    rawCanaryVisible: false,
  });
}

function operationFromRequest(url: URL): RetentionOperation | undefined {
  if (url.pathname === '/replay') return undefined;
  const pathPart = url.pathname.split('/').filter(Boolean).at(-1);
  const runCase = url.searchParams.get('case');
  const selected =
    url.pathname === '/run'
      ? runCase?.startsWith('retention-')
        ? 'run'
        : undefined
      : pathPart === 'retention'
        ? url.searchParams.get('op')
        : pathPart;
  const operations: readonly RetentionOperation[] = [
    'run',
    'prepare',
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
  ];
  return operations.find((operation) => operation === selected);
}

/** Dispatches retention routes against an actual RuntimeGateAgent surface. */
export async function handleRetentionRequest(
  request: Request,
  surface: RetentionRuntimeSurface,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const operation = operationFromRequest(url);
  if (operation === undefined) return undefined;
  if (request.method !== 'GET') return new Response('Not Found', { status: 404 });
  ensureTables(surface);
  const install = installAudit(surface);
  if (operation === 'prepare') {
    return Response.json({ prepared: true, writeAuditInstall: install, rawCanaryVisible: false });
  }
  if (operation === 'run') return runRetention(url, surface, install);
  if (operation === 'expire') return expireRetention(url, surface, install);
  if (operation === 'persistence' || operation === 'report') {
    return Response.json({
      operation,
      audit: await audit(surface),
      writeAudit: writeAudit(surface),
      writeAuditInstall: install,
      sdk: {
        messages: countRows(surface, 'cf_ai_chat_agent_messages'),
        stream: countRows(surface, 'cf_ai_chat_stream_chunks'),
      },
      instanceToken: surface.instanceToken(),
      rawCanaryVisible: false,
    });
  }
  if (operation === 'save' || operation === 'saved' || operation === 'saved-delete') {
    return savedOperation(operation, url, surface);
  }
  if (operation === 'clear') {
    await surface.clearChat();
    return Response.json({
      cleared: true,
      sdkHistoryRows: countRows(surface, 'cf_ai_chat_agent_messages'),
      sdkStreamRows: countRows(surface, 'cf_ai_chat_stream_chunks'),
      savedRows: countRows(surface, RETENTION_SAVED_TABLE),
      rawCanaryVisible: false,
    });
  }
  if (operation === 'sweep') return sweepRetention(url, surface);
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
    return Response.json({
      deleted: true,
      sdkHistoryRowsAfter: countRows(surface, 'cf_ai_chat_agent_messages'),
      sdkStreamRowsAfter: countRows(surface, 'cf_ai_chat_stream_chunks'),
      savedRowsAfter: countRows(surface, RETENTION_SAVED_TABLE),
      rawCanaryVisible: false,
    });
  }
  return Response.json({ code: scrubError('RETENTION_OPERATION_UNHANDLED') }, { status: 500 });
}
