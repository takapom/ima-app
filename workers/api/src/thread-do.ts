import { Think } from '@cloudflare/think';
import { DurableObject } from 'cloudflare:workers';

export type ThreadState = 'active' | 'cancelled' | 'ended' | 'restarted' | 'resumed';

export type ThreadSnapshot = {
  readonly threadId: string;
  readonly ownerScopeRef: string;
  readonly revision: number;
  readonly active: boolean;
  readonly state: ThreadState;
};

export type ThreadAuthorization =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'NOT_FOUND' | 'FORBIDDEN' };

export type ThreadStateErrorCode = 'NOT_FOUND' | 'FORBIDDEN';

export type ThreadConflictErrorCode = 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT';
export type ThreadOperationErrorCode = ThreadStateErrorCode | ThreadConflictErrorCode;

/** Internal DO error; bootstrap maps it to the public status without exposing scope values. */
export class ThreadStateError extends Error {
  readonly code: ThreadStateErrorCode;

  constructor(code: ThreadStateErrorCode) {
    super('thread state is unavailable');
    this.name = 'ThreadStateError';
    this.code = code;
  }
}

/** RPC may deserialize Error instances without preserving their prototype. */
export const isThreadStateError = (value: unknown): value is ThreadStateError => {
  if (value instanceof ThreadStateError) return true;
  if (typeof value !== 'object' || value === null) return false;
  if (!('name' in value) || value.name !== 'ThreadStateError') return false;
  if (!('code' in value)) return false;
  return value.code === 'NOT_FOUND' || value.code === 'FORBIDDEN';
};

export class ThreadConflictError extends Error {
  readonly code: ThreadConflictErrorCode;

  constructor(code: ThreadConflictErrorCode) {
    super('thread operation conflicts with current state');
    this.name = 'ThreadConflictError';
    this.code = code;
  }
}

export const isThreadConflictError = (value: unknown): value is ThreadConflictError => {
  if (value instanceof ThreadConflictError) return true;
  if (typeof value !== 'object' || value === null) return false;
  if (!('name' in value) || value.name !== 'ThreadConflictError') return false;
  if (!('code' in value)) return false;
  return value.code === 'REVISION_CONFLICT' || value.code === 'IDEMPOTENCY_CONFLICT';
};

export type ThreadSnapshotResult =
  | { readonly ok: true; readonly snapshot: ThreadSnapshot }
  | { readonly ok: false; readonly code: ThreadOperationErrorCode };

export type ThreadDeleteResult =
  { readonly ok: true } | { readonly ok: false; readonly code: ThreadOperationErrorCode };

type ThreadRow = {
  readonly thread_id: string;
  readonly owner_scope_ref: string;
  readonly revision: number;
  readonly active: number;
  readonly state: string;
  readonly deleted: number;
};

type ThreadOperationRow = {
  readonly idempotency_key: string;
  readonly owner_scope_ref: string;
  readonly action: string;
  readonly turn_id: string | null;
  readonly expected_revision: number;
  readonly result_revision: number;
  readonly result_active: number;
  readonly result_state: string;
};

type ThreadAction = Exclude<ThreadState, 'active'>;

const isThreadState = (value: string): value is ThreadState =>
  value === 'active' ||
  value === 'cancelled' ||
  value === 'ended' ||
  value === 'restarted' ||
  value === 'resumed';

const stateOf = (value: string): ThreadState => {
  if (isThreadState(value)) return value;
  throw new Error('THREAD_STATE_CORRUPT');
};

/**
 * The M05 boundary and the later Think runtime share one Durable Object class.
 * Think is deliberately configured with no model/tools here; M05 only exposes
 * the owner-bound state methods. M10 can add the native loop without creating
 * a second per-thread object or migrating the binding.
 */
export class ThreadDO extends Think<Cloudflare.Env> {
  override includeMcpTools = false;
  override workspaceBash = false;
  override fetchTools = false as const;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(() =>
      Promise.resolve().then(() => {
        ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS thread_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            thread_id TEXT NOT NULL,
            owner_scope_ref TEXT NOT NULL,
            revision INTEGER NOT NULL,
            active INTEGER NOT NULL CHECK (active IN (0, 1)),
            state TEXT NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
          )
        `);
        ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS thread_operation (
            idempotency_key TEXT PRIMARY KEY,
            owner_scope_ref TEXT NOT NULL,
            action TEXT NOT NULL,
            turn_id TEXT,
            expected_revision INTEGER NOT NULL,
            result_revision INTEGER NOT NULL,
            result_active INTEGER NOT NULL CHECK (result_active IN (0, 1)),
            result_state TEXT NOT NULL
          )
        `);
      }),
    );
  }

  private async row(): Promise<ThreadRow | undefined> {
    await this.ready;
    return this.rowSync();
  }

  private rowSync(): ThreadRow | undefined {
    return this.ctx.storage.sql
      .exec<ThreadRow>(
        'SELECT thread_id, owner_scope_ref, revision, active, state, deleted FROM thread_state WHERE singleton = 1',
      )
      .toArray()[0];
  }

  private operationSync(idempotencyKey: string): ThreadOperationRow | undefined {
    return this.ctx.storage.sql
      .exec<ThreadOperationRow>(
        'SELECT idempotency_key, owner_scope_ref, action, turn_id, expected_revision, result_revision, result_active, result_state FROM thread_operation WHERE idempotency_key = ?',
        idempotencyKey,
      )
      .toArray()[0];
  }

  private snapshot(row: ThreadRow): ThreadSnapshot {
    return {
      threadId: row.thread_id,
      ownerScopeRef: row.owner_scope_ref,
      revision: row.revision,
      active: row.active === 1,
      state: stateOf(row.state),
    };
  }

  private checkOwner(row: ThreadRow | undefined, ownerScopeRef: string): ThreadRow {
    if (row === undefined || row.deleted === 1) throw new ThreadStateError('NOT_FOUND');
    if (row.owner_scope_ref !== ownerScopeRef) throw new ThreadStateError('FORBIDDEN');
    return row;
  }

  private checkOwnerIncludingDeleted(row: ThreadRow | undefined, ownerScopeRef: string): ThreadRow {
    if (row === undefined) throw new ThreadStateError('NOT_FOUND');
    if (row.owner_scope_ref !== ownerScopeRef) throw new ThreadStateError('FORBIDDEN');
    return row;
  }

  private checkOperation(
    operation: ThreadOperationRow | undefined,
    ownerScopeRef: string,
    action: string,
    turnId: string | null,
    expectedRevision: number,
  ): ThreadOperationRow | undefined {
    if (operation === undefined) return undefined;
    if (
      operation.owner_scope_ref !== ownerScopeRef ||
      operation.action !== action ||
      operation.turn_id !== turnId ||
      operation.expected_revision !== expectedRevision
    ) {
      throw new ThreadConflictError('IDEMPOTENCY_CONFLICT');
    }
    return operation;
  }

  private snapshotFromOperation(row: ThreadRow, operation: ThreadOperationRow): ThreadSnapshot {
    return {
      threadId: row.thread_id,
      ownerScopeRef: row.owner_scope_ref,
      revision: operation.result_revision,
      active: operation.result_active === 1,
      state: stateOf(operation.result_state),
    };
  }

  /** Creates the owner binding once; a later different owner can never rebind the thread. */
  async initialize(ownerScopeRef: string, threadId: string): Promise<ThreadSnapshotResult> {
    await this.ready;
    try {
      const snapshot = this.ctx.storage.transactionSync(() => {
        const existing = this.rowSync();
        if (existing !== undefined) {
          const bound = this.checkOwner(existing, ownerScopeRef);
          return this.snapshot(bound);
        }
        this.ctx.storage.sql.exec(
          'INSERT INTO thread_state (singleton, thread_id, owner_scope_ref, revision, active, state, deleted) VALUES (1, ?, ?, 1, 1, ?, 0)',
          threadId,
          ownerScopeRef,
          'active',
        );
        const created = this.rowSync();
        if (created === undefined) throw new Error('THREAD_INITIALIZATION_FAILED');
        return this.snapshot(created);
      });
      return { ok: true, snapshot };
    } catch (error: unknown) {
      if (isThreadStateError(error)) return { ok: false, code: error.code };
      throw error;
    }
  }

  async read(ownerScopeRef: string): Promise<ThreadSnapshotResult> {
    try {
      return {
        ok: true,
        snapshot: this.snapshot(this.checkOwner(await this.row(), ownerScopeRef)),
      };
    } catch (error: unknown) {
      if (isThreadStateError(error)) return { ok: false, code: error.code };
      throw error;
    }
  }

  async authorize(ownerScopeRef: string): Promise<ThreadAuthorization> {
    const row = await this.row();
    if (row === undefined) return { allowed: false, reason: 'NOT_FOUND' };
    if (row.owner_scope_ref !== ownerScopeRef) {
      return { allowed: false, reason: row.deleted === 1 ? 'NOT_FOUND' : 'FORBIDDEN' };
    }
    // A tombstoned owner passes only to reach its own idempotency ledger;
    // read/replay and new mutations still reject the deleted state.
    return { allowed: true };
  }

  async replay(ownerScopeRef: string): Promise<ThreadSnapshotResult> {
    return this.read(ownerScopeRef);
  }

  async applyLifecycle(
    ownerScopeRef: string,
    action: ThreadAction,
    turnId: string | null,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<ThreadSnapshotResult> {
    await this.ready;
    try {
      const snapshot = this.ctx.storage.transactionSync(() => {
        const current = this.checkOwnerIncludingDeleted(this.rowSync(), ownerScopeRef);
        const prior = this.checkOperation(
          this.operationSync(idempotencyKey),
          ownerScopeRef,
          action,
          turnId,
          expectedRevision,
        );
        if (prior !== undefined) return this.snapshotFromOperation(current, prior);
        if (current.deleted === 1) throw new ThreadStateError('NOT_FOUND');
        if (expectedRevision !== current.revision) {
          throw new ThreadConflictError('REVISION_CONFLICT');
        }
        const active = action === 'cancelled' || action === 'ended' ? 0 : 1;
        const revision = current.revision + 1;
        this.ctx.storage.sql.exec(
          'UPDATE thread_state SET revision = ?, active = ?, state = ? WHERE singleton = 1',
          revision,
          active,
          action,
        );
        const updated = this.rowSync();
        if (updated === undefined) throw new Error('THREAD_UPDATE_FAILED');
        this.ctx.storage.sql.exec(
          'INSERT INTO thread_operation (idempotency_key, owner_scope_ref, action, turn_id, expected_revision, result_revision, result_active, result_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          idempotencyKey,
          ownerScopeRef,
          action,
          turnId,
          expectedRevision,
          updated.revision,
          updated.active,
          updated.state,
        );
        return this.snapshot(updated);
      });
      return { ok: true, snapshot };
    } catch (error: unknown) {
      if (isThreadStateError(error) || isThreadConflictError(error)) {
        return { ok: false, code: error.code };
      }
      throw error;
    }
  }

  async deleteThread(
    ownerScopeRef: string,
    turnId: string | null,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<ThreadDeleteResult> {
    await this.ready;
    try {
      this.ctx.storage.transactionSync(() => {
        const current = this.checkOwnerIncludingDeleted(this.rowSync(), ownerScopeRef);
        const prior = this.checkOperation(
          this.operationSync(idempotencyKey),
          ownerScopeRef,
          'delete',
          turnId,
          expectedRevision,
        );
        if (prior !== undefined) return;
        if (current.deleted === 1) throw new ThreadStateError('NOT_FOUND');
        if (expectedRevision !== current.revision) {
          throw new ThreadConflictError('REVISION_CONFLICT');
        }
        this.ctx.storage.sql.exec(
          'UPDATE thread_state SET active = 0, state = ?, deleted = 1 WHERE singleton = 1',
          'ended',
        );
        this.ctx.storage.sql.exec(
          'INSERT INTO thread_operation (idempotency_key, owner_scope_ref, action, turn_id, expected_revision, result_revision, result_active, result_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          idempotencyKey,
          ownerScopeRef,
          'delete',
          turnId,
          expectedRevision,
          current.revision,
          0,
          'ended',
        );
      });
      return { ok: true };
    } catch (error: unknown) {
      if (isThreadStateError(error) || isThreadConflictError(error)) {
        return { ok: false, code: error.code };
      }
      throw error;
    }
  }
}

export type RateLimitConfig = {
  readonly windowMs: number;
  readonly devicePerWindow: number;
  readonly ownerPerWindow: number;
};

export type RateLimitCheckInput = {
  readonly ownerScopeRef: string;
  readonly deviceId: string;
  readonly route: string;
  readonly config: RateLimitConfig;
};

export type RateLimitCheckResult =
  | { readonly allowed: true; readonly retryAfterSeconds: null }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

type RateWindowRow = {
  readonly key: string;
  readonly started_at: number;
  readonly count: number;
};

const validRateConfig = (config: RateLimitConfig): boolean =>
  Number.isSafeInteger(config.windowMs) &&
  config.windowMs > 0 &&
  Number.isSafeInteger(config.devicePerWindow) &&
  config.devicePerWindow > 0 &&
  Number.isSafeInteger(config.ownerPerWindow) &&
  config.ownerPerWindow > 0;

export class RateLimitDO extends DurableObject {
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(() =>
      Promise.resolve().then(() => {
        ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS rate_window (
            key TEXT PRIMARY KEY,
            started_at INTEGER NOT NULL,
            count INTEGER NOT NULL
          )
        `);
      }),
    );
  }

  private window(key: string): RateWindowRow | undefined {
    return this.ctx.storage.sql
      .exec<RateWindowRow>('SELECT key, started_at, count FROM rate_window WHERE key = ?', key)
      .toArray()[0];
  }

  private writeWindow(key: string, startedAt: number, count: number): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO rate_window (key, started_at, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET started_at = excluded.started_at, count = excluded.count',
      key,
      startedAt,
      count,
    );
  }

  async check(input: RateLimitCheckInput): Promise<RateLimitCheckResult> {
    await this.ready;
    if (!validRateConfig(input.config)) throw new Error('RATE_LIMIT_CONFIGURATION');
    void input.route;
    const now = Date.now();
    const ownerKey = `owner:${input.ownerScopeRef}`;
    const deviceKey = `device:${input.deviceId}`;
    const owner = this.window(ownerKey);
    const device = this.window(deviceKey);
    const ownerActive = owner !== undefined && now - owner.started_at < input.config.windowMs;
    const deviceActive = device !== undefined && now - device.started_at < input.config.windowMs;
    const ownerCount = ownerActive ? owner.count : 0;
    const deviceCount = deviceActive ? device.count : 0;
    const ownerLimited = ownerCount >= input.config.ownerPerWindow;
    const deviceLimited = deviceCount >= input.config.devicePerWindow;
    if (ownerLimited || deviceLimited) {
      const startedAt = ownerLimited ? owner?.started_at : device?.started_at;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(((startedAt ?? now) + input.config.windowMs - now) / 1_000),
      );
      return { allowed: false, retryAfterSeconds };
    }
    this.writeWindow(ownerKey, ownerActive ? (owner?.started_at ?? now) : now, ownerCount + 1);
    this.writeWindow(deviceKey, deviceActive ? (device?.started_at ?? now) : now, deviceCount + 1);
    return { allowed: true, retryAfterSeconds: null };
  }
}
