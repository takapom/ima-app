import { initializeThreadStorage } from '@worker/infrastructure/adapters/outbound/persistence/thread/schema';
import { DurableRuntimeTurnStore } from '@worker/infrastructure/adapters/outbound/persistence/thread/turn-store';
import { RuntimeProductionThinkHost } from '@worker/entrypoints/cloudflare/runtime-production-host';
import {
  createRuntimeSavedCandidateResolver,
  runtimeSavedCandidateBindingFor,
  type RuntimeSavedCandidateResult,
} from '@worker/infrastructure/runtime/threads/runtime-saved-candidate-rpc';
import { ThreadRuntimeController } from '@worker/infrastructure/runtime/threads/controller';
import { runtimeThreadBindingFor } from '@worker/infrastructure/runtime/threads/runtime-thread-binding';
import {
  createDurableCommitPort,
  type DurableCommitPort,
} from '@worker/infrastructure/adapters/outbound/persistence/thread/durable-commit-adapter';
import {
  runtimeFailure,
  type ThreadRuntimeCancelResult,
  type ThreadRuntimeReplayResult,
  type ThreadRuntimeResponseMetadata,
  type ThreadRuntimeTurnResult,
} from '@worker/infrastructure/runtime/threads/admission';
import { executeRuntimeThreadTurn } from '@worker/infrastructure/runtime/threads/runtime-thread-turn-execution';
import { createRuntimeSessionExpiryGate } from '@worker/infrastructure/runtime/threads/session-expiry';
import { cleanupRuntimeResources } from '@worker/infrastructure/runtime/threads/thread-cleanup';
import {
  isThreadConflictError,
  isThreadStateError,
  ThreadConflictError,
  ThreadStateError,
  type ThreadAuthorization,
  type ThreadDeleteResult,
  type ThreadSnapshot,
  type ThreadSnapshotResult,
} from '@worker/infrastructure/runtime/threads/thread-types';

import { createThreadPhotoReferences } from '@worker/infrastructure/adapters/outbound/persistence/photo/thread-references';
import type { PhotoReferenceRecord } from '@worker/infrastructure/runtime/ports/photo';
import type {
  PhotoReferenceGetResult,
  PhotoReferencePutResult,
  PhotoReferenceRpc,
} from '@worker/infrastructure/adapters/outbound/persistence/photo/rpc';
import {
  stateOf,
  snapshotFromOperation,
  type ThreadAction,
  type ThreadOperationRow,
  type ThreadRow,
} from '@worker/infrastructure/adapters/outbound/persistence/thread/thread-do-state';
export { RateLimitDO } from '@worker/infrastructure/adapters/outbound/persistence/security/rate-limit-do';
export type {
  RateLimitCheckInput,
  RateLimitCheckResult,
  RateLimitConfig,
} from '@worker/infrastructure/adapters/outbound/persistence/security/rate-limit-do';
export {
  isThreadConflictError,
  isThreadStateError,
  ThreadConflictError,
  ThreadStateError,
} from '@worker/infrastructure/runtime/threads/thread-types';
export type {
  ThreadAuthorization,
  ThreadConflictErrorCode,
  ThreadDeleteResult,
  ThreadOperationErrorCode,
  ThreadSnapshot,
  ThreadSnapshotResult,
  ThreadState,
  ThreadStateErrorCode,
} from '@worker/infrastructure/runtime/threads/thread-types';

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
        initializeThreadStorage(ctx.storage);
      }),
    );
    this.runtimeController = new ThreadRuntimeController({
      store: new DurableRuntimeTurnStore({
        storage: ctx.storage,
        readBinding: () => runtimeThreadBindingFor(this.rowSync()),
        commitResponse: () => false,
      }),
      ready: () => this.ready,
      getConnection: () => this.ensureRuntimeThinkConnection(),
      execute: (input, target, isStale) =>
        executeRuntimeThreadTurn({
          input,
          target,
          isStale,
          run: (request) => this.requireRuntimeThinkConnection().run(request),
        }),
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
