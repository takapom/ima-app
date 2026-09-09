import { env } from 'cloudflare:workers';
import { evictDurableObject, SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

const BASE = 'https://ima.test/v1/runtime-gate';
const AGENT_PREFIX = 'retention-runtime-fixture';
const MARKERS = ['M04_PROVIDER_QUOTE_CANARY', 'M04_GENERATED_CANARY'];
const createdAt = '2026-09-08T04:20:00+09:00';
let activeAgent = `${AGENT_PREFIX}-default`;

type RetentionAuditJson = {
  messages: { forbiddenEntries: number };
  storage: {
    observed: boolean;
    writeObservation: 'after-read-only';
    forbiddenEntries: number;
    readErrors: number;
  };
  sql: {
    observed: boolean;
    readErrors: number;
    tables: readonly { forbiddenRows: number }[];
    unobservedTables: readonly {
      tableName: string;
      status: string;
      reason: string;
    }[];
  };
};

type RetentionRuntimeJson = {
  result: { status: string; error?: string | null };
  responseId: string | null;
  instanceToken: string;
  persistenceAfter: RetentionAuditJson;
  writeAudit: { observed: boolean; readErrors: number; forbiddenWrites: number };
  writeAuditInstall: { observed: boolean; readErrors: number; installErrors: number };
  savedCount: number;
  sessionExpiresAt: string;
  freshUntil: string;
  displayUntil: string;
  retentionUntil: string;
  physicalDeleteAt: string;
  restoreMode: string;
  body: string | null;
  bodyResent: boolean;
  code: string | null;
  rewrite: {
    expired: readonly { turnId: string }[];
    active: readonly { turnId: string }[];
  };
  sdkHistoryRows: number;
  sdkStreamRows: number;
  savedRows: number;
  sdkHistoryRowsAfter: number;
  savedRowsAfter: number;
  audit: RetentionAuditJson;
  [key: string]: unknown;
};

async function call(
  path = '',
  parameters: Record<string, string> = {},
): Promise<{ status: number; json: RetentionRuntimeJson }> {
  const query = new URLSearchParams({ agent: activeAgent, ...parameters });
  const suffix = query.size === 0 ? '' : `?${query}`;
  const response = await SELF.fetch(`${BASE}${path}${suffix}`);
  return { status: response.status, json: await response.json() };
}

async function run(
  name: string,
  policy: string,
  options: Record<string, string> = {},
): Promise<ReturnType<typeof call>> {
  return call('', {
    case: 'retention-run',
    policy,
    owner: `owner-${name}`,
    thread: `thread-${name}`,
    turn: `turn-${name}-${crypto.randomUUID()}`,
    createdAt,
    ...options,
  });
}

async function evictRuntimeGate(): Promise<void> {
  const stub = env.RUNTIME_GATE.getByName(activeAgent);
  await evictDurableObject(stub);
}

function useAgent(name: string): void {
  activeAgent = `${AGENT_PREFIX}-${name}`;
}

function bodyText(value: unknown): string {
  return JSON.stringify(value);
}

function requiredId(value: string | null): string {
  if (value === null) throw new Error('test expected a response id');
  return value;
}

it('scrubs denied and unknown provider content before the real SDK write', async () => {
  useAgent('policy');
  for (const policy of ['deny', 'unknown']) {
    const result = await run(`policy-${policy}`, policy);
    expect(result.status).toBe(200);
    expect(result.json.result.status).toBe('completed');
    expect(result.json.persistenceAfter.messages.forbiddenEntries).toBe(0);
    expect(result.json.persistenceAfter.sql.observed).toBe(true);
    expect(result.json.persistenceAfter.sql.readErrors).toBe(0);
    expect(result.json.persistenceAfter.sql.unobservedTables).toEqual([
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
    ]);
    expect(
      result.json.persistenceAfter.sql.tables.every(
        (table: { forbiddenRows: number }) => table.forbiddenRows === 0,
      ),
    ).toBe(true);
    expect(result.json.persistenceAfter.storage.observed).toBe(true);
    expect(result.json.persistenceAfter.storage.writeObservation).toBe('after-read-only');
    expect(result.json.persistenceAfter.storage.readErrors).toBe(0);
    expect(result.json.persistenceAfter.storage.forbiddenEntries).toBe(0);
    expect(result.json.writeAudit.observed).toBe(true);
    expect(result.json.writeAudit.readErrors).toBe(0);
    expect(result.json.writeAudit.forbiddenWrites).toBe(0);
    expect(result.json.writeAuditInstall.observed).toBe(true);
    expect(result.json.writeAuditInstall.readErrors).toBe(0);
    expect(bodyText(result.json)).not.toContain(MARKERS[0]);
    expect(bodyText(result.json)).not.toContain(MARKERS[1]);
  }
});

it('keeps separate response records for separate turns in one real DO', async () => {
  useAgent('turns');
  const first = await run('turn-old', 'allow', { turn: 'turn-old' });
  const second = await run('turn-new', 'allow', { turn: 'turn-new' });
  expect(first.json.responseId).toBeTruthy();
  expect(second.json.responseId).toBeTruthy();
  expect(first.json.responseId).not.toBe(second.json.responseId);
  const firstRead = await call('/read', {
    responseId: requiredId(first.json.responseId),
    owner: 'owner-turn-old',
    at: '2026-09-08T04:21:00+09:00',
  });
  const secondRead = await call('/read', {
    responseId: requiredId(second.json.responseId),
    owner: 'owner-turn-new',
    at: '2026-09-08T04:21:00+09:00',
  });
  expect(firstRead.status).toBe(200);
  expect(secondRead.status).toBe(200);
  expect(firstRead.json.responseId).not.toBe(secondRead.json.responseId);
});

it('fails closed for provider failure and disconnect without a response commit', async () => {
  useAgent('failure');
  for (const policy of ['failure', 'disconnect']) {
    const result = await run(`failure-${policy}`, policy);
    expect(result.status).toBe(200);
    expect(['error', 'aborted']).toContain(result.json.result?.status);
    expect(result.json.responseId).toBeNull();
    expect(result.json.persistenceAfter.messages.forbiddenEntries).toBe(0);
    expect(result.json.writeAudit.forbiddenWrites).toBe(0);
    expect(bodyText(result.json)).not.toContain(MARKERS[0]);
    expect(bodyText(result.json)).not.toContain(MARKERS[1]);
  }
});

it('recovers a withheld response after real DO eviction without restoring its body', async () => {
  useAgent('recovery');
  const first = await run('recovery', 'deny');
  const responseId = requiredId(first.json.responseId);
  const oldInstanceToken = first.json.instanceToken;
  await evictRuntimeGate();
  const recovered = await call('/recover', {
    responseId,
    owner: 'owner-recovery',
    at: '2026-09-08T04:21:00+09:00',
  });
  expect(recovered.status).toBe(200);
  expect(recovered.json.instanceToken).not.toBe(oldInstanceToken);
  expect(recovered.json.responseId).toBe(responseId);
  expect(recovered.json.restoreMode).toBe('reference_only');
  expect(recovered.json.body).toBeNull();
  expect(recovered.json.bodyResent).toBe(false);
  expect(bodyText(recovered.json)).not.toContain(MARKERS[0]);
  expect(bodyText(recovered.json)).not.toContain(MARKERS[1]);
});

it('enforces freshness, display, retention, and physical-delete boundaries', async () => {
  useAgent('boundary');
  const first = await run('boundary', 'allow');
  const responseId = requiredId(first.json.responseId);
  const saved = await call('/save', {
    responseId,
    owner: 'owner-boundary',
    savedRef: 'saved-boundary',
  });
  expect(saved.json.savedCount).toBe(1);
  const beforeFresh = await call('/read', {
    responseId,
    owner: 'owner-boundary',
    at: '2026-09-08T04:24:59+09:00',
  });
  expect(beforeFresh.status).toBe(200);
  expect(beforeFresh.json.restoreMode).toBe('full');
  expect(new Date(beforeFresh.json.freshUntil).valueOf()).toBeLessThan(
    new Date(beforeFresh.json.displayUntil).valueOf(),
  );
  expect(new Date(beforeFresh.json.displayUntil).valueOf()).toBeLessThan(
    new Date(beforeFresh.json.retentionUntil).valueOf(),
  );
  expect(new Date(beforeFresh.json.retentionUntil).valueOf()).toBeLessThan(
    new Date(beforeFresh.json.physicalDeleteAt).valueOf(),
  );
  const remodelBeforeFresh = await call('/remodel', {
    responseId,
    owner: 'owner-boundary',
    at: '2026-09-08T04:24:59+09:00',
  });
  expect(remodelBeforeFresh.status).toBe(200);
  const freshBoundary = await call('/remodel', {
    responseId,
    owner: 'owner-boundary',
    at: '2026-09-08T04:25:00+09:00',
  });
  expect(freshBoundary.status).toBe(409);
  expect(freshBoundary.json.code).toBe('FRESHNESS_EXPIRED');
  const displayBoundary = await call('/display', {
    responseId,
    owner: 'owner-boundary',
    at: '2026-09-08T04:30:00+09:00',
  });
  expect(displayBoundary.status).toBe(410);
  expect(displayBoundary.json.code).toBe('DISPLAY_EXPIRED');
  const retentionBoundary = await call('/read', {
    responseId,
    owner: 'owner-boundary',
    at: '2026-09-08T04:35:00+09:00',
  });
  expect(retentionBoundary.status).toBe(410);
  expect(retentionBoundary.json.code).toBe('RETENTION_EXPIRED');
  const beforeDelete = await call('/sweep', { at: '2026-09-08T04:35:30+09:00' });
  expect(beforeDelete.json.physicalDeleted).toBe(0);
  const deleted = await call('/sweep', { at: '2026-09-08T04:36:00+09:00' });
  expect(deleted.json.physicalDeleted).toBe(1);
  expect(deleted.json.sdkHistoryRows).toBe(0);
  expect(deleted.json.sdkStreamRows).toBe(0);
  expect(deleted.json.savedRows).toBe(1);
  expect((await call('/read', { responseId, owner: 'owner-boundary' })).status).toBe(404);
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
  const beforeRead = await call('/read', {
    responseId: requiredId(before.json.responseId),
    owner: 'owner-session-before',
    at: '2026-09-08T04:59:59+09:00',
  });
  const exactRead = await call('/read', {
    responseId: requiredId(exact.json.responseId),
    owner: 'owner-session-exact',
    at: '2026-09-08T05:00:00+09:00',
  });
  expect(beforeRead.json.sessionExpiresAt).toBe('2026-09-08T05:00:00+09:00');
  expect(exactRead.json.sessionExpiresAt).toBe('2026-09-09T05:00:00+09:00');
});

it('keeps saved references independent from implicit save and thread deletion', async () => {
  useAgent('delete');
  const first = await run('delete', 'allow');
  const responseId = requiredId(first.json.responseId);
  expect((await call('/saved', { owner: 'owner-delete' })).json.savedCount).toBe(0);
  expect(
    (await call('/save', { responseId, owner: 'owner-delete', savedRef: 'saved-delete' })).json
      .savedCount,
  ).toBe(1);
  expect((await call('/delete', { responseId, owner: 'owner-other' })).status).toBe(403);
  const deleted = await call('/delete', { responseId, owner: 'owner-delete' });
  expect(deleted.status).toBe(200);
  expect(deleted.json.sdkHistoryRowsAfter).toBe(0);
  expect(deleted.json.savedRowsAfter).toBe(1);
  expect((await call('/saved', { owner: 'owner-delete' })).json.savedCount).toBe(1);
  expect(bodyText(deleted.json)).not.toContain(MARKERS[0]);
});

it('rewrites only expired turns through public persistMessages and keeps a valid turn', async () => {
  useAgent('multi');
  const old = await run('multi', 'allow', {
    turn: 'turn-old',
    expiresAt: '2026-09-08T04:20:30+09:00',
  });
  await run('multi', 'allow', {
    turn: 'turn-new',
    createdAt: '2026-09-08T04:21:00+09:00',
    expiresAt: '2026-09-08T04:22:00+09:00',
    payload: 'safe',
  });
  expect(old.json.persistenceAfter.sql.observed).toBe(true);
  expect(old.json.persistenceAfter.messages.forbiddenEntries).toBeGreaterThan(0);
  const rewritten = await call('/expire', {
    owner: 'owner-multi',
    at: '2026-09-08T04:21:30+09:00',
  });
  expect(rewritten.status).toBe(200);
  expect(
    rewritten.json.rewrite.expired.some((entry: { turnId: string }) => entry.turnId === 'turn-old'),
  ).toBe(true);
  expect(
    rewritten.json.rewrite.active.some((entry: { turnId: string }) => entry.turnId === 'turn-new'),
  ).toBe(true);
  expect(rewritten.json.persistenceAfter.messages.forbiddenEntries).toBe(0);
  expect(rewritten.json.persistenceAfter.storage.observed).toBe(true);
  expect(rewritten.json.persistenceAfter.storage.readErrors).toBe(0);
  expect(rewritten.json.persistenceAfter.sql.readErrors).toBe(0);
  expect(
    rewritten.json.persistenceAfter.sql.tables.every(
      (table: { forbiddenRows: number }) => table.forbiddenRows === 0,
    ),
  ).toBe(true);
  expect(rewritten.json.writeAudit.forbiddenWrites).toBe(0);
  await evictRuntimeGate();
  const reopened = await call('/persistence');
  expect(reopened.json.audit.messages.forbiddenEntries).toBe(0);
  expect(reopened.json.audit.storage.forbiddenEntries).toBe(0);
  expect(bodyText(reopened.json)).not.toContain(MARKERS[0]);
});

it('clears SDK history while retaining and then deleting saved references', async () => {
  useAgent('clear');
  const first = await run('clear', 'deny');
  await call('/save', {
    responseId: requiredId(first.json.responseId),
    owner: 'owner-clear',
    savedRef: 'saved-clear',
  });
  const cleared = await call('/clear');
  expect(cleared.status).toBe(200);
  expect(cleared.json.sdkHistoryRows).toBe(0);
  expect(cleared.json.sdkStreamRows).toBe(0);
  expect(cleared.json.savedRows).toBe(1);
  expect((await call('/saved', { owner: 'owner-clear' })).json.savedCount).toBe(1);
  const removed = await call('/saved-delete', { owner: 'owner-clear', savedRef: 'saved-clear' });
  expect(removed.status).toBe(200);
  expect(removed.json.savedCount).toBe(0);
});
