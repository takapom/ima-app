import type { DurableObjectCapability } from 'agents/lifecycle';

export const RUNTIME_RETENTION_ALARM_TABLE = 'runtime_retention_alarm';

type RuntimeRetentionAlarmRow = {
  readonly completed_at: string | null;
  readonly deadline_at: string | null;
  readonly observed_at: string | null;
  readonly delay_ms: number | null;
  readonly failure_count: number;
  readonly retry_at: string | null;
};

type AlarmColumnRow = { readonly name: string };

export type RuntimeRetentionAlarmInput = {
  readonly storage: DurableObjectStorage;
  readonly now: () => string;
  readonly expiryAt: () => string | undefined;
  readonly onDue: (markComplete: () => void) => Promise<boolean>;
  readonly rearm?: () => Promise<void>;
};

const ensureAlarmTable = (storage: DurableObjectStorage): void => {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${RUNTIME_RETENTION_ALARM_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      deadline_at TEXT,
      completed_at TEXT,
      observed_at TEXT,
      delay_ms INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0,
      retry_at TEXT
    )
  `);
  const columns = new Set(
    storage.sql
      .exec<AlarmColumnRow>(`PRAGMA table_info(${RUNTIME_RETENTION_ALARM_TABLE})`)
      .toArray()
      .map((row) => row.name),
  );
  if (!columns.has('failure_count')) {
    storage.sql.exec(
      `ALTER TABLE ${RUNTIME_RETENTION_ALARM_TABLE} ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!columns.has('retry_at')) {
    storage.sql.exec(`ALTER TABLE ${RUNTIME_RETENTION_ALARM_TABLE} ADD COLUMN retry_at TEXT`);
  }
};

const readAlarm = (storage: DurableObjectStorage): RuntimeRetentionAlarmRow | undefined =>
  storage.sql
    .exec<RuntimeRetentionAlarmRow>(
      `SELECT deadline_at, completed_at, observed_at, delay_ms, failure_count, retry_at
       FROM ${RUNTIME_RETENTION_ALARM_TABLE}
       WHERE singleton = 1`,
    )
    .toArray()[0];

const safeNow = (
  input: RuntimeRetentionAlarmInput,
): { readonly text: string; readonly ms: number } => {
  try {
    const text = input.now();
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) return { text, ms };
  } catch {
    // An invalid clock is handled as an immediate fail-closed cleanup attempt.
  }
  const ms = Date.now();
  return { text: new Date(ms).toISOString(), ms };
};

const safeExpiry = (
  input: RuntimeRetentionAlarmInput,
): { readonly text: string; readonly ms: number } | undefined => {
  try {
    const text = input.expiryAt();
    if (text === undefined) return undefined;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? { text, ms } : undefined;
  } catch {
    return undefined;
  }
};

const markComplete = (
  input: RuntimeRetentionAlarmInput,
  deadline: { readonly text: string; readonly ms: number } | undefined,
): void => {
  const now = safeNow(input);
  const delay = deadline === undefined ? null : Math.max(0, now.ms - deadline.ms);
  input.storage.sql.exec(
    `INSERT INTO ${RUNTIME_RETENTION_ALARM_TABLE}
       (singleton, deadline_at, completed_at, observed_at, delay_ms)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       deadline_at = excluded.deadline_at,
       completed_at = excluded.completed_at,
       observed_at = excluded.observed_at,
       delay_ms = excluded.delay_ms,
       failure_count = 0,
       retry_at = NULL`,
    deadline?.text ?? null,
    now.text,
    now.text,
    delay,
  );
};

const recordFailure = (input: RuntimeRetentionAlarmInput): void => {
  const current = readAlarm(input.storage);
  const failureCount = (current?.failure_count ?? 0) + 1;
  const retryDelay = Math.min(15 * 60 * 1_000, 2 ** Math.min(failureCount - 1, 10) * 1_000);
  const retryAt = new Date(safeNow(input).ms + retryDelay).toISOString();
  input.storage.sql.exec(
    `INSERT INTO ${RUNTIME_RETENTION_ALARM_TABLE}
       (singleton, completed_at, failure_count, retry_at)
     VALUES (1, NULL, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       failure_count = excluded.failure_count,
       retry_at = excluded.retry_at`,
    failureCount,
    retryAt,
  );
};

const nextAlarm = (input: RuntimeRetentionAlarmInput): number | null => {
  const row = readAlarm(input.storage);
  if (row?.completed_at !== null && row?.completed_at !== undefined) return null;
  const now = safeNow(input);
  if (row?.retry_at !== null && row?.retry_at !== undefined) {
    const retryAt = Date.parse(row.retry_at);
    if (Number.isFinite(retryAt) && now.ms < retryAt) return retryAt;
  }
  const deadline = safeExpiry(input);
  if (deadline === undefined || now.ms >= deadline.ms) {
    return Math.max(Date.now() + 1, now.ms + 1);
  }
  return deadline.ms;
};

/**
 * Supplies retention cleanup as an Agents Lifecycle capability. It intentionally never calls
 * storage.setAlarm: Lifecycle combines this request with Think's own alarm contributors.
 */
export const createRuntimeRetentionAlarmCapability = (
  input: RuntimeRetentionAlarmInput,
): DurableObjectCapability => {
  ensureAlarmTable(input.storage);
  return {
    onStart: () => input.rearm?.(),
    getNextAlarm: () => nextAlarm(input),
    onAlarm: async () => {
      const row = readAlarm(input.storage);
      if (row?.completed_at !== null && row?.completed_at !== undefined) return;
      const deadline = safeExpiry(input);
      const now = safeNow(input);
      if (row?.retry_at !== null && row?.retry_at !== undefined) {
        const retryAt = Date.parse(row.retry_at);
        if (Number.isFinite(retryAt) && now.ms < retryAt) return;
      }
      if (deadline !== undefined && now.ms < deadline.ms) return;
      let marked = false;
      const complete = (): void => {
        if (marked) return;
        markComplete(input, deadline);
        marked = true;
      };
      let expired = false;
      try {
        expired = await input.onDue(complete);
      } catch {
        // Lifecycle stops its own rearm path when a capability throws. Record a bounded retry
        // and return normally so the combined scheduler can request the next alarm.
        recordFailure(input);
        await input.rearm?.();
        return;
      }
      if (expired && !marked) {
        recordFailure(input);
        await input.rearm?.();
      }
    },
  };
};
