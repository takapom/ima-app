import { env } from 'cloudflare:workers';
import { evictDurableObject, SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { ThinkRuntimeGateAgent } from '../think-runtime-agent';

const BASE = 'https://ima.test/v1/think-runtime';
const AGENT_PREFIX = 'think-retention-fixture';
const MARKERS = ['M04_PROVIDER_QUOTE_CANARY', 'M04_GENERATED_CANARY'];
const CREATED_AT = '2026-09-08T04:20:00+09:00';
let activeAgent = `${AGENT_PREFIX}-default`;

type JsonObject = Record<string, unknown>;
type ThinkRuntimeTestEnv = Cloudflare.Env & {
  THINK_RUNTIME: DurableObjectNamespace<ThinkRuntimeGateAgent>;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasThinkRuntime(value: unknown): value is ThinkRuntimeTestEnv {
  return typeof value === 'object' && value !== null && 'THINK_RUNTIME' in value;
}

async function call(
  path: string,
  parameters: Record<string, string> = {},
): Promise<{ status: number; json: JsonObject }> {
  const query = new URLSearchParams({ agent: activeAgent, ...parameters });
  const response = await SELF.fetch(`${BASE}${path}?${query}`);
  const value: unknown = await response.json();
  if (!isJsonObject(value)) throw new Error('expected JSON object');
  return { status: response.status, json: value };
}

async function run(
  name: string,
  policy: string,
  options: Record<string, string> = {},
): Promise<{ status: number; json: JsonObject }> {
  return call('/retention', {
    op: 'run',
    case: 'retention-run',
    owner: `owner-${name}`,
    thread: `thread-${name}`,
    turn: `turn-${name}-${crypto.randomUUID()}`,
    createdAt: CREATED_AT,
    policy,
    ...options,
  });
}

function useAgent(name: string): void {
  activeAgent = `${AGENT_PREFIX}-${name}`;
}

async function evictThink(): Promise<void> {
  if (!hasThinkRuntime(env)) throw new Error('THINK_RUNTIME_BINDING_MISSING');
  const stub = env.THINK_RUNTIME.getByName(activeAgent);
  await evictDurableObject(stub);
}

function textOf(value: unknown): string {
  return JSON.stringify(value);
}

function stringValue(value: unknown, key: string): string {
  if (!isJsonObject(value) || typeof value[key] !== 'string') {
    throw new Error(`missing string field: ${key}`);
  }
  return value[key];
}

function objectValue(value: unknown, key: string): JsonObject {
  if (!isJsonObject(value) || !isJsonObject(value[key])) {
    throw new Error(`missing object field: ${key}`);
  }
  return value[key];
}

function noForbiddenPayload(value: unknown): void {
  expect(textOf(value)).not.toContain(MARKERS[0]);
  expect(textOf(value)).not.toContain(MARKERS[1]);
}

function expectCleanAudit(report: JsonObject): void {
  const persistence =
    'persistenceAfter' in report
      ? objectValue(report, 'persistenceAfter')
      : objectValue(report, 'audit');
  const messages = objectValue(persistence, 'messages');
  expect(messages.forbiddenEntries).toBe(0);
  const sql = objectValue(persistence, 'sql');
  expect(sql.observed).toBe(true);
  expect(sql.readErrors).toBe(0);
  const tables = sql.tables;
  if (!Array.isArray(tables)) throw new Error('missing sql tables');
  for (const table of tables) {
    if (!isJsonObject(table)) throw new Error('invalid sql table observation');
    expect(table.forbiddenRows).toBe(0);
  }
  const storage = objectValue(persistence, 'storage');
  expect(storage.observed).toBe(true);
  expect(storage.readErrors).toBe(0);
  expect(storage.forbiddenEntries).toBe(0);
}

it('scrubs denied and unknown payloads before public Think persistence', async () => {
  useAgent('policy');
  for (const policy of ['deny', 'unknown']) {
    const result = await run(`policy-${policy}`, policy);
    expect(result.status).toBe(200);
    expect(objectValue(result.json, 'result').status).toBe('completed');
    expectCleanAudit(result.json);
    expect(objectValue(result.json, 'writeAudit').forbiddenWrites).toBe(0);
    noForbiddenPayload(result.json);
  }
});

it('keeps separate response records across multiple turns in one real Think DO', async () => {
  useAgent('turns');
  const first = await run('turn-old', 'deny', {
    owner: 'owner-turns',
    thread: 'thread-turns',
    turn: 'turn-old',
  });
  const second = await run('turn-new', 'deny', {
    owner: 'owner-turns',
    thread: 'thread-turns',
    turn: 'turn-new',
  });
  expect(stringValue(first.json, 'responseId')).not.toBe(stringValue(second.json, 'responseId'));
  const report = await call('/retention', { op: 'report' });
  const sdk = objectValue(report.json, 'sdk');
  expect(sdk.sessionMessages).toBeGreaterThan(0);
  expect(sdk.compactions).toBe(0);
  noForbiddenPayload(report.json);
});

it('fails closed for provider failure and disconnect without a response row', async () => {
  useAgent('failure');
  for (const policy of ['failure', 'disconnect']) {
    const result = await run(`failure-${policy}`, policy);
    expect(result.status).toBe(200);
    expect(['error', 'aborted']).toContain(objectValue(result.json, 'result').status);
    expect(result.json.responseId).toBeNull();
    const persistence = objectValue(result.json, 'persistenceAfter');
    expect(objectValue(persistence, 'messages').forbiddenEntries).toBe(0);
    expect(objectValue(result.json, 'writeAudit').forbiddenWrites).toBe(0);
    noForbiddenPayload(result.json);
  }
});

it('reopens a withheld response after real DO eviction without restoring its body', async () => {
  useAgent('recovery');
  const first = await run('recovery', 'deny');
  const responseId = stringValue(first.json, 'responseId');
  const oldToken = stringValue(first.json, 'instanceToken');
  await evictThink();
  const recovered = await call('/retention', {
    op: 'recover',
    responseId,
    owner: 'owner-recovery',
    at: '2026-09-08T04:21:00+09:00',
  });
  expect(recovered.status).toBe(200);
  expect(stringValue(recovered.json, 'instanceToken')).not.toBe(oldToken);
  expect(recovered.json.restoreMode).toBe('reference_only');
  expect(recovered.json.body).toBeNull();
  expect(recovered.json.bodyResent).toBe(false);
  noForbiddenPayload(recovered.json);
});

it('keeps freshness, display, retention, physical delete, and saved-ref boundaries separate', async () => {
  useAgent('boundary');
  const first = await run('boundary', 'allow', { payload: 'safe' });
  const responseId = stringValue(first.json, 'responseId');
  const saved = await call('/retention', {
    op: 'save',
    responseId,
    owner: 'owner-boundary',
    savedRef: 'saved-boundary',
  });
  expect(saved.json.savedCount).toBe(1);
  const beforeFresh = await call('/retention', {
    op: 'read',
    responseId,
    owner: 'owner-boundary',
    at: '2026-09-08T04:24:59+09:00',
  });
  expect(beforeFresh.status).toBe(200);
  expect(beforeFresh.json.restoreMode).toBe('full');
  expect(new Date(stringValue(beforeFresh.json, 'freshUntil')).valueOf()).toBeLessThan(
    new Date(stringValue(beforeFresh.json, 'displayUntil')).valueOf(),
  );
  expect(new Date(stringValue(beforeFresh.json, 'displayUntil')).valueOf()).toBeLessThan(
    new Date(stringValue(beforeFresh.json, 'retentionUntil')).valueOf(),
  );
  expect(new Date(stringValue(beforeFresh.json, 'retentionUntil')).valueOf()).toBeLessThan(
    new Date(stringValue(beforeFresh.json, 'physicalDeleteAt')).valueOf(),
  );
  expect(
    (
      await call('/retention', {
        op: 'remodel',
        responseId,
        owner: 'owner-boundary',
        at: '2026-09-08T04:25:00+09:00',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('/retention', {
        op: 'display',
        responseId,
        owner: 'owner-boundary',
        at: '2026-09-08T04:30:00+09:00',
      })
    ).status,
  ).toBe(410);
  expect(
    (
      await call('/retention', {
        op: 'read',
        responseId,
        owner: 'owner-boundary',
        at: '2026-09-08T04:35:00+09:00',
      })
    ).status,
  ).toBe(410);
  const deleted = await call('/retention', { op: 'sweep', at: '2026-09-08T04:36:00+09:00' });
  expect(deleted.json.physicalDeleted).toBe(1);
  expect(deleted.json.savedRows).toBe(1);
  expect(
    (await call('/retention', { op: 'read', responseId, owner: 'owner-boundary' })).status,
  ).toBe(404);
});

it('uses the first and exact next-day 05:00 session boundaries', async () => {
  useAgent('session');
  const before = await run('session-before', 'allow', {
    createdAt: '2026-09-08T04:59:59+09:00',
    turn: 'turn-session-before',
  });
  const exact = await run('session-exact', 'allow', {
    createdAt: '2026-09-08T05:00:00+09:00',
    turn: 'turn-session-exact',
  });
  const beforeRead = await call('/retention', {
    op: 'read',
    responseId: stringValue(before.json, 'responseId'),
    owner: 'owner-session-before',
    at: '2026-09-08T04:59:59+09:00',
  });
  const exactRead = await call('/retention', {
    op: 'read',
    responseId: stringValue(exact.json, 'responseId'),
    owner: 'owner-session-exact',
    at: '2026-09-08T05:00:00+09:00',
  });
  expect(beforeRead.json.sessionExpiresAt).toBe('2026-09-08T05:00:00+09:00');
  expect(exactRead.json.sessionExpiresAt).toBe('2026-09-09T05:00:00+09:00');
});

it('keeps saved references independent from clear and owner-scoped deletion', async () => {
  useAgent('saved');
  const first = await run('saved', 'deny');
  const responseId = stringValue(first.json, 'responseId');
  expect((await call('/retention', { op: 'saved', owner: 'owner-saved' })).json.savedCount).toBe(0);
  expect(
    (
      await call('/retention', {
        op: 'save',
        responseId,
        owner: 'owner-saved',
        savedRef: 'saved-ref',
      })
    ).json.savedCount,
  ).toBe(1);
  expect(
    (await call('/retention', { op: 'delete', responseId, owner: 'owner-other' })).status,
  ).toBe(403);
  const deleted = await call('/retention', { op: 'delete', responseId, owner: 'owner-saved' });
  expect(deleted.status).toBe(200);
  expect(deleted.json.savedRows).toBe(1);
  expect((await call('/retention', { op: 'saved', owner: 'owner-saved' })).json.savedCount).toBe(1);
  const clear = await call('/retention', { op: 'clear' });
  expect(clear.status).toBe(200);
  expect(objectValue(clear.json, 'sdk').sessionMessages).toBe(0);
  expect(clear.json.savedRows).toBe(1);
  expect(
    (await call('/retention', { op: 'saved-delete', owner: 'owner-saved', savedRef: 'saved-ref' }))
      .json.savedCount,
  ).toBe(0);
});

it('rewrites an expired old turn through public Session.updateMessage and keeps a new turn', async () => {
  useAgent('multi');
  const old = await run('multi', 'allow', {
    owner: 'owner-multi',
    thread: 'thread-multi',
    turn: 'turn-old',
    expiresAt: '2026-09-08T04:20:30+09:00',
  });
  await call('/retention', {
    op: 'save',
    responseId: stringValue(old.json, 'responseId'),
    owner: 'owner-multi',
    savedRef: 'saved-old',
  });
  const current = await run('multi', 'allow', {
    owner: 'owner-multi',
    thread: 'thread-multi',
    turn: 'turn-new',
    createdAt: '2026-09-08T04:21:00+09:00',
    expiresAt: '2026-09-08T04:22:00+09:00',
    payload: 'safe',
  });
  expect(current.status).toBe(200);
  const rewritten = await call('/retention', {
    op: 'expire',
    owner: 'owner-multi',
    at: '2026-09-08T04:21:30+09:00',
  });
  expect(rewritten.status).toBe(200);
  const rewrite = objectValue(rewritten.json, 'rewrite');
  expect(rewrite.publicPerMessageExpirySupported).toBe(true);
  expect(rewrite.publicBulkPersistSupported).toBe(false);
  expect(rewrite.privateRewriteUsed).toBe(false);
  expect(rewrite.publicRewriteMethod).toBe('Session.updateMessage');
  expect(Array.isArray(rewrite.expired)).toBe(true);
  expect(textOf(rewrite.expired)).toContain('turn-old');
  expect(textOf(rewrite.active)).toContain('turn-new');
  expect(
    objectValue(objectValue(rewritten.json, 'persistenceAfter'), 'messages').forbiddenEntries,
  ).toBe(0);
  expect(objectValue(rewritten.json, 'writeAudit').forbiddenWrites).toBe(0);
  expect(rewritten.json.savedCount).toBe(1);
  await evictThink();
  const reopened = await call('/retention', { op: 'persistence' });
  expectCleanAudit({ ...reopened.json, persistenceAfter: reopened.json.audit });
  noForbiddenPayload(reopened.json);
});

it('sanitizes compaction summary before public Session.addCompaction and reports unused routes', async () => {
  useAgent('compaction');
  const first = await run('compaction', 'deny');
  expect(first.status).toBe(200);
  const compact = await call('/retention', {
    op: 'compact',
    summary: 'arbitrary provider text with no fixture marker',
  });
  expect(compact.status).toBe(200);
  const compaction = objectValue(compact.json, 'compaction');
  expect(compaction.summarySanitized).toBe(true);
  expect(compaction.summaryIsFixedPlaceholder).toBe(true);
  expect(objectValue(compact.json, 'writeAudit').forbiddenWrites).toBe(0);
  expectCleanAudit(compact.json);
  const sdk = objectValue(compact.json, 'sdk');
  expect(sdk.compactions).toBe(1);
  const inventory = objectValue(sdk, 'inventory');
  expect(objectValue(inventory, 'stream').state).not.toBe('read-error');
  expect(objectValue(inventory, 'workspace').reason).toContain('workspaceBash=false');
  expect(objectValue(inventory, 'recovery').reason).toContain('alarm');
  noForbiddenPayload(compact.json);
});
