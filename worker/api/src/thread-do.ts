import { RuntimeProductionThinkHost } from '@api/thread-runtime/runtime-production-host';
import {
  createRuntimeSavedCandidateResolver,
  runtimeSavedCandidateBindingFor,
  type RuntimeSavedCandidateResult,
} from '@api/thread-runtime/runtime-saved-candidate-rpc';
import { ThreadRuntimeController } from '@api/thread-runtime/controller';
import { runtimeThreadBindingFor } from '@api/thread-runtime/runtime-thread-binding';
import {
  createDurableCommitPort,
  initializeDurableCommitTable,
  type DurableCommitPort,
} from '@api/thread-runtime/commit-port';
import {
  runtimeFailure,
  type ThreadRuntimeCancelResult,
  type ThreadRuntimeReplayResult,
  type ThreadRuntimeResponseMetadata,
  type ThreadRuntimeTurnResult,
} from '@api/thread-runtime/admission';
import { executeRuntimeThreadTurn } from '@api/thread-runtime/runtime-thread-turn-execution';
import { createRuntimeSessionExpiryGate } from '@api/thread-runtime/session-expiry';
import { cleanupRuntimeResources } from '@api/thread-runtime/thread-cleanup';
import {
  isThreadConflictError,
  isThreadStateError,
  ThreadConflictError,
  ThreadStateError,
  type ThreadAuthorization,
  type ThreadDeleteResult,
  type ThreadSnapshot,
  type ThreadSnapshotResult,
} from '@api/thread-types';

import { createThreadPhotoReferences } from '@api/providers/photo/thread-references';
import type { PhotoReferenceRecord } from '@api/providers/photo/types';
import type {
  PhotoReferenceGetResult,
  PhotoReferencePutResult,
  PhotoReferenceRpc,
} from '@api/providers/photo/rpc';
import {
  stateOf,
  snapshotFromOperation,
  type ThreadAction,
  type ThreadOperationRow,
  type ThreadRow,
} from '@api/thread-do-state';
export { RateLimitDO } from '@api/rate-limit-do';
export type {
  RateLimitCheckInput,
  RateLimitCheckResult,
  RateLimitConfig,
} from '@api/rate-limit-do';
export {
  isThreadConflictError,
  isThreadStateError,
  ThreadConflictError,
  ThreadStateError,
} from '@api/thread-types';
export type {
  ThreadAuthorization,
  ThreadConflictErrorCode,
  ThreadDeleteResult,
  ThreadOperationErrorCode,
  ThreadSnapshot,
  ThreadSnapshotResult,
  ThreadState,
  ThreadStateErrorCode,
} from '@api/thread-types';

export type ThreadSavedCandidateResult = RuntimeSavedCandidateResult;

/** One DO owns owner-bound lifecycle, photo references, and the configured Think runtime. */
export class ThreadDO
  extends RuntimeProductionThinkHost<Cloudflare.Env>
  implements PhotoReferenceRpc
{
  override includeMcpTools = false;
  override workspaceBash = false;
  override fetchTools = false as const;
  private readonly ready: Promise<void>;
  private readonly runtimeController: ThreadRuntimeController;
  private readonly runtimeCommit: DurableCommitPort;
  private readonly sessionExpired = createRuntimeSessionExpiryGate({
    isExpired: () => this.runtimeProductionSessionExpired(),
    readScope: () => {
      const row = this.rowSync();
      return row === undefined
        ? undefined
        : { ownerScopeRef: row.owner_scope_ref, threadId: row.thread_id };
    },
    cleanupRuntime: () => this.runtimeController.cleanupForDelete(),
    clearContext: (scope) => this.clearRuntimeProductionContext(scope),
    clearPhotos: () => this.photoReferences.clear(),
  });
  private readonly photoReferences = createThreadPhotoReferences({
    clock: () => this.photoReferenceNow(),
    binding: () => this.rowSync(),
  });

  protected photoReferenceNow(): string {
    return new Date().toISOString();
  }

  private readonly savedCandidateResolver = createRuntimeSavedCandidateResolver({
    ready: () => this.ready,
    expired: () => this.sessionExpired(),
    read: () => runtimeSavedCandidateBindingFor(this.rowSync()),
    snapshotFor: (scope) => this.runtimeProductionContextReferenceFor(scope),
    now: () => this.runtimeProductionNow(),
  });

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
      readBinding: () => runtimeThreadBindingFor(this.rowSync()),
      getConnection: () => this.ensureRuntimeThinkConnection(),
      execute: (input, target, isStale) =>
        executeRuntimeThreadTurn({
          input,
          target,
          isStale,
          run: (request) => this.requireRuntimeThinkConnection().run(request),
        }),
      commitResponse: () => false,
      onFinalResult: (target, result, durationMs) => {
        this.recordRuntimeTurnTrace(target, result, durationMs);
      },
      clearMessages: () => this.clearRuntimeMessages(),
    });
  }

  protected override async runtimeProductionRetentionAlarmDue(
    markComplete: () => void,
  ): Promise<boolean> {
    await this.ready;
    return this.sessionExpired(markComplete);
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

  async initialize(
    ownerScopeRef: string,
    threadId: string,
    requireActiveSession = false,
  ): Promise<ThreadSnapshotResult> {
    await this.ready;
    await this.startRuntimeLifecycle();
    if (requireActiveSession && (await this.sessionExpired()))
      return { ok: false, code: 'NOT_FOUND' };
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

  async putPhotoReference(
    ownerScopeRef: string,
    record: PhotoReferenceRecord,
    now: string,
  ): Promise<PhotoReferencePutResult> {
    await this.ready;
    return this.photoReferences.putPhotoReference(ownerScopeRef, record, now);
  }

  async getPhotoReference(
    ownerScopeRef: string,
    handle: string,
    deviceIdHash: string,
    now: string,
  ): Promise<PhotoReferenceGetResult> {
    await this.ready;
    return this.photoReferences.getPhotoReference(ownerScopeRef, handle, deviceIdHash, now);
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
        if (prior !== undefined) return snapshotFromOperation(current, prior);
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
      if (cleanupRequired) {
        await cleanupRuntimeResources({
          cleanupRuntime: () => this.runtimeController.cleanupForDelete(),
          clearContext: () => {
            const row = this.rowSync();
            if (row !== undefined) {
              this.clearRuntimeProductionContext({
                ownerScopeRef,
                threadId: row.thread_id,
              });
            }
          },
          clearPhotos: () => this.photoReferences.clear(),
        });
      }
      return { ok: true };
    } catch (error: unknown) {
      if (isThreadStateError(error) || isThreadConflictError(error)) {
        return { ok: false, code: error.code };
      }
      throw error;
    }
  }

  async runRuntimeTurn(value: unknown): Promise<ThreadRuntimeTurnResult> {
    await this.ready;
    if (await this.sessionExpired()) return runtimeFailure('RUNTIME_FAILED');
    return this.runtimeController.runRuntimeTurn(value);
  }

  async cancelRuntimeTurn(value: unknown): Promise<ThreadRuntimeCancelResult> {
    return this.runtimeController.cancelRuntimeTurn(value);
  }

  async replayRuntimeTurn(value: unknown): Promise<ThreadRuntimeReplayResult> {
    await this.ready;
    if (await this.sessionExpired()) return { status: 'unavailable', code: 'NOT_FOUND' };
    return this.runtimeController.replayRuntimeTurn(value);
  }

  async listRuntimeResponses(ownerScopeRef: string): Promise<ThreadRuntimeResponseMetadata[]> {
    await this.ready;
    if (await this.sessionExpired()) return [];
    return this.runtimeController.listRuntimeResponses(ownerScopeRef);
  }

  async resolveCandidateForSavedReference(
    ownerScopeRef: unknown,
    candidateId: unknown,
    expectedRevision: unknown,
  ): Promise<ThreadSavedCandidateResult> {
    return this.savedCandidateResolver.resolve(ownerScopeRef, candidateId, expectedRevision);
  }
}
