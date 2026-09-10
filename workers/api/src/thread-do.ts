import * as v from 'valibot';
import { AssistantResponseSchema } from '@ima/contracts';
import { RuntimeThinkHost } from './thread-runtime/runtime-host';
import { ThreadRuntimeController, type RuntimeThreadBinding } from './thread-runtime/controller';
import {
  advanceThreadRevision,
  createDurableCommitPort,
  initializeDurableCommitTable,
  type DurableCommitPort,
} from './thread-runtime/commit-port';
import {
  type ThreadRuntimeCancelResult,
  type ThreadRuntimeReplayResult,
  type ThreadRuntimeResponseMetadata,
  type ThreadRuntimeTarget,
  type ThreadRuntimeTurnInput,
  type ThreadRuntimeTurnResult,
  runtimeFailure,
} from './thread-runtime/admission';
import {
  isThreadConflictError,
  isThreadStateError,
  ThreadConflictError,
  ThreadStateError,
  type ThreadAuthorization,
  type ThreadDeleteResult,
  type ThreadSnapshot,
  type ThreadSnapshotResult,
  type ThreadState,
} from './thread-types';
export { RateLimitDO } from './rate-limit-do';
export type { RateLimitCheckInput, RateLimitCheckResult, RateLimitConfig } from './rate-limit-do';
export {
  isThreadConflictError,
  isThreadStateError,
  ThreadConflictError,
  ThreadStateError,
} from './thread-types';
export type {
  ThreadAuthorization,
  ThreadConflictErrorCode,
  ThreadDeleteResult,
  ThreadOperationErrorCode,
  ThreadSnapshot,
  ThreadSnapshotResult,
  ThreadState,
  ThreadStateErrorCode,
} from './thread-types';

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
export class ThreadDO extends RuntimeThinkHost<Cloudflare.Env> {
  override includeMcpTools = false;
  override workspaceBash = false;
  override fetchTools = false as const;
  private readonly ready: Promise<void>;
  private readonly runtimeController: ThreadRuntimeController;
  private readonly runtimeCommit: DurableCommitPort;

  /** Native fixtures may opt into their in-memory CommitPort explicitly. */
  protected runtimeCommitFallbackEnabled(): boolean {
    return false;
  }

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.runtimeCommit = createDurableCommitPort(ctx.storage);
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
        ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS runtime_turn (
            turn_id TEXT NOT NULL,
            owner_scope_ref TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            idempotency_key TEXT NOT NULL,
            input_digest TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('running', 'cancel_requested', 'cancelled', 'stale', 'completed', 'failed')),
            request_id TEXT,
            response_id TEXT,
            response_revision INTEGER,
            response_kind TEXT CHECK (response_kind IN ('message', 'cards')),
            response_presentation TEXT CHECK (response_presentation IN ('keep', 'replace')),
            response_card_set_id TEXT,
            PRIMARY KEY (thread_id, turn_id, revision),
            UNIQUE (idempotency_key)
          )
        `);
        initializeDurableCommitTable(ctx.storage);
      }),
    );
    this.runtimeController = new ThreadRuntimeController({
      storage: ctx.storage,
      ready: () => this.ready,
      readBinding: (): RuntimeThreadBinding | undefined => {
        const row = this.rowSync();
        if (row === undefined) return undefined;
        return {
          threadId: row.thread_id,
          ownerScopeRef: row.owner_scope_ref,
          revision: row.revision,
          active: row.active === 1,
          deleted: row.deleted === 1,
        };
      },
      getConnection: () => this.ensureRuntimeThinkConnection(),
      execute: (input, target, isStale) => this.executeRuntimeTurn(input, target, isStale),
      commitResponse: (target, responseRevision) =>
        this.runtimeCommitFallbackEnabled() &&
        advanceThreadRevision(ctx.storage, target, responseRevision),
      clearMessages: () => this.clearRuntimeMessages(),
    });
  }

  /** Runtime composition uses this adapter; the Core port never sees DO or SDK types. */
  protected createRuntimeCommitPort(): DurableCommitPort {
    return this.runtimeCommit;
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
      this.runtimeController.cancelRuntimeForLifecycle(
        ownerScopeRef,
        snapshot.threadId,
        expectedRevision,
        turnId,
      );
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
    let cleanupRequired = false;
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
        if (prior !== undefined) {
          cleanupRequired = true;
          return;
        }
        if (current.deleted === 1) throw new ThreadStateError('NOT_FOUND');
        if (expectedRevision !== current.revision) {
          throw new ThreadConflictError('REVISION_CONFLICT');
        }
        cleanupRequired = true;
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
      if (cleanupRequired) await this.runtimeController.cleanupForDelete();
      return { ok: true };
    } catch (error: unknown) {
      if (isThreadStateError(error) || isThreadConflictError(error)) {
        return { ok: false, code: error.code };
      }
      throw error;
    }
  }

  private async executeRuntimeTurn(
    input: ThreadRuntimeTurnInput,
    target: ThreadRuntimeTarget,
    isStale: () => boolean,
  ): Promise<ThreadRuntimeTurnResult> {
    const runtime = this.requireRuntimeThinkConnection();
    const request = {
      ownerScopeRef: target.ownerScopeRef,
      threadId: target.threadId,
      turnId: target.turnId,
      revision: target.revision,
      messages: [
        {
          id: input.input.requestId,
          role: 'user' as const,
          parts: [{ type: 'text' as const, text: input.input.text }],
        },
      ],
      runtimeInput: input.input,
      isStale,
    };
    const nativeResult = await runtime.run(request);
    if (nativeResult.status === 'completed') {
      const parsed = v.safeParse(AssistantResponseSchema, nativeResult.response);
      if (!parsed.success) {
        return runtimeFailure('RUNTIME_FAILED', nativeResult.requestId);
      }
      return {
        status: 'completed',
        requestId: nativeResult.requestId,
        response: parsed.output,
      };
    }
    if (nativeResult.status === 'aborted') {
      return {
        status: isStale() ? 'stale' : 'cancelled',
        requestId: nativeResult.requestId,
        response: null,
        code: isStale() ? 'STALE_TURN' : 'CANCELLED',
      };
    }
    if (nativeResult.status === 'skipped') {
      return {
        status: 'stale',
        requestId: nativeResult.requestId,
        response: null,
        code: 'STALE_TURN',
      };
    }
    if (nativeResult.status === 'error') {
      throw new Error(nativeResult.error ?? 'runtime Think turn failed');
    }
    throw new Error('runtime Think turn returned an unknown status');
  }

  async runRuntimeTurn(value: unknown): Promise<ThreadRuntimeTurnResult> {
    return this.runtimeController.runRuntimeTurn(value);
  }

  async cancelRuntimeTurn(value: unknown): Promise<ThreadRuntimeCancelResult> {
    return this.runtimeController.cancelRuntimeTurn(value);
  }

  async replayRuntimeTurn(value: unknown): Promise<ThreadRuntimeReplayResult> {
    return this.runtimeController.replayRuntimeTurn(value);
  }

  async listRuntimeResponses(ownerScopeRef: string): Promise<ThreadRuntimeResponseMetadata[]> {
    return this.runtimeController.listRuntimeResponses(ownerScopeRef);
  }
}
