import {
  cancelledRuntimeResult,
  isThreadRuntimeTarget,
  runtimeFailure,
  type ThreadRuntimeCancelResult,
  type ThreadRuntimeReplayResult,
  type ThreadRuntimeResponseMetadata,
  type ThreadRuntimeTarget,
  type ThreadRuntimeTurnInput,
  type ThreadRuntimeTurnResult,
} from '@worker/runtime/threads/admission';
import type {
  RuntimeThreadBinding,
  RuntimeTurnStore,
  RuntimeTurnAdmissionOutcome as AdmissionOutcome,
} from '@worker/runtime/ports/turn-store';
import { persistRuntimeResult } from '@worker/adapters/outbound/persistence/thread/result-persistence';
import { cancelRuntimeForLifecycleRows } from '@worker/adapters/outbound/persistence/thread/lifecycle-cancel';
import { isRuntimeTargetStale } from '@worker/runtime/threads/stale-check';
type RuntimeTurnRow = {
  readonly turn_id: string;
  readonly owner_scope_ref: string;
  readonly thread_id: string;
  readonly revision: number;
  readonly idempotency_key: string;
  readonly input_digest: string;
  readonly status: 'running' | 'cancel_requested' | 'cancelled' | 'stale' | 'completed' | 'failed';
  readonly request_id: string | null;
  readonly response_id: string | null;
  readonly response_revision: number | null;
  readonly response_kind: 'message' | 'cards' | null;
  readonly response_presentation: 'keep' | 'replace' | null;
  readonly response_card_set_id: string | null;
};
const targetFromRow = (row: RuntimeTurnRow): ThreadRuntimeTarget => ({
  ownerScopeRef: row.owner_scope_ref,
  threadId: row.thread_id,
  turnId: row.turn_id,
  revision: row.revision,
});

const resultFromRow = (row: RuntimeTurnRow): ThreadRuntimeTurnResult => {
  if (row.status === 'completed') {
    if (
      row.response_id === null ||
      row.response_revision === null ||
      row.response_kind === null ||
      row.response_presentation === null
    ) {
      return runtimeFailure('RUNTIME_FAILED', row.request_id);
    }
    return {
      status: 'completed',
      requestId: row.request_id,
      response: {
        turnId: row.turn_id,
        responseId: row.response_id,
        revision: row.response_revision,
        kind: row.response_kind,
        presentation: row.response_presentation,
        cardSetId: row.response_card_set_id,
        restoreMode: 'reference_only' as const,
      },
    };
  }
  if (row.status === 'stale') return runtimeFailure('STALE_TURN', row.request_id);
  if (row.status === 'failed') return runtimeFailure('RUNTIME_FAILED', row.request_id);
  return cancelledRuntimeResult();
};

const responseColumns =
  'response_revision, response_kind, response_presentation, response_card_set_id';

type DurableRuntimeTurnStoreOptions = {
  readonly storage: DurableObjectStorage;
  readonly readBinding: () => RuntimeThreadBinding | undefined;
  readonly commitResponse?: (target: ThreadRuntimeTarget, revision: number) => boolean;
};
export class DurableRuntimeTurnStore implements RuntimeTurnStore {
  constructor(private readonly options: DurableRuntimeTurnStoreOptions) {}
  private rowSync(target: ThreadRuntimeTarget): RuntimeTurnRow | undefined {
    return this.options.storage.sql
      .exec<RuntimeTurnRow>(
        `SELECT turn_id, owner_scope_ref, thread_id, revision, idempotency_key, input_digest, status, request_id, response_id, ${responseColumns} FROM runtime_turn WHERE thread_id = ? AND turn_id = ? AND revision = ?`,
        target.threadId,
        target.turnId,
        target.revision,
      )
      .toArray()[0];
  }

  private rowByIdempotencySync(idempotencyKey: string): RuntimeTurnRow | undefined {
    return this.options.storage.sql
      .exec<RuntimeTurnRow>(
        `SELECT turn_id, owner_scope_ref, thread_id, revision, idempotency_key, input_digest, status, request_id, response_id, ${responseColumns} FROM runtime_turn WHERE idempotency_key = ?`,
        idempotencyKey,
      )
      .toArray()[0];
  }

  private activeRowSync(): RuntimeTurnRow | undefined {
    return this.options.storage.sql
      .exec<RuntimeTurnRow>(
        `SELECT turn_id, owner_scope_ref, thread_id, revision, idempotency_key, input_digest, status, request_id, response_id, ${responseColumns} FROM runtime_turn WHERE status IN ('running', 'cancel_requested') ORDER BY revision DESC LIMIT 1`,
      )
      .toArray()[0];
  }

  private bindingFor(target: ThreadRuntimeTarget): RuntimeThreadBinding | undefined {
    const binding = this.options.readBinding();
    if (
      binding === undefined ||
      binding.threadId !== target.threadId ||
      binding.ownerScopeRef !== target.ownerScopeRef ||
      binding.deleted
    ) {
      return undefined;
    }
    return binding;
  }

  admit(input: ThreadRuntimeTurnInput, inputDigest: string): AdmissionOutcome {
    const target: ThreadRuntimeTarget = input;
    const result = this.options.storage.transactionSync(() => {
      const binding = this.bindingFor(target);
      if (binding === undefined) return runtimeFailure('NOT_FOUND');
      const same = this.rowSync(target);
      if (same !== undefined) {
        if (
          same.status !== 'cancelled' &&
          (same.idempotency_key !== input.idempotencyKey || same.input_digest !== inputDigest)
        ) {
          return runtimeFailure('IDEMPOTENCY_CONFLICT');
        }
        if (same.status === 'completed' || same.status === 'failed' || same.status === 'stale') {
          return same.status === 'completed'
            ? runtimeFailure('IDEMPOTENCY_CONFLICT', same.request_id)
            : resultFromRow(same);
        }
        if (same.status === 'cancelled') return resultFromRow(same);
        return runtimeFailure('TURN_ALREADY_ACTIVE');
      }
      if (binding.revision !== target.revision || !binding.active) {
        return runtimeFailure('STALE_TURN');
      }
      const byKey = this.rowByIdempotencySync(input.idempotencyKey);
      if (byKey !== undefined) return runtimeFailure('IDEMPOTENCY_CONFLICT');
      const active = this.activeRowSync();
      let previousActive: ThreadRuntimeTarget | undefined;
      if (active !== undefined) {
        if (active.revision >= target.revision) {
          return runtimeFailure('TURN_ALREADY_ACTIVE');
        }
        previousActive = targetFromRow(active);
        this.options.storage.sql.exec(
          "UPDATE runtime_turn SET status = 'stale' WHERE thread_id = ? AND turn_id = ? AND revision = ?",
          active.thread_id,
          active.turn_id,
          active.revision,
        );
      }
      this.options.storage.sql.exec(
        'INSERT INTO runtime_turn (turn_id, owner_scope_ref, thread_id, revision, idempotency_key, input_digest, status, request_id, response_id, response_revision, response_kind, response_presentation, response_card_set_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        target.turnId,
        target.ownerScopeRef,
        target.threadId,
        target.revision,
        input.idempotencyKey,
        inputDigest,
        'running',
        null,
        null,
        null,
        null,
        null,
        null,
      );
      return {
        admission:
          previousActive === undefined
            ? { status: 'admitted' as const }
            : { status: 'admitted' as const, invalidate: previousActive },
        previousActive,
      };
    });
    if ('admission' in result) return result;
    return { admission: { status: 'rejected', result }, previousActive: undefined };
  }

  updateResult(
    target: ThreadRuntimeTarget,
    result: ThreadRuntimeTurnResult,
  ): ThreadRuntimeTurnResult {
    return persistRuntimeResult({ ...this.options, target, result });
  }
  status(target: ThreadRuntimeTarget) {
    return this.rowSync(target)?.status;
  }
  requestCancellation(target: ThreadRuntimeTarget): {
    result: ThreadRuntimeCancelResult;
    shouldCancel: boolean;
  } {
    let shouldCancel = false;
    const result = this.options.storage.transactionSync(() => {
      const binding = this.bindingFor(target);
      if (binding === undefined) return { status: 'rejected' as const, code: 'NOT_FOUND' as const };
      if (binding.revision !== target.revision) {
        return {
          status: 'stale' as const,
          code: 'STALE_TURN' as const,
        };
      }
      const row = this.rowSync(target);
      if (row === undefined) {
        this.options.storage.sql.exec(
          'INSERT INTO runtime_turn (turn_id, owner_scope_ref, thread_id, revision, idempotency_key, input_digest, status, request_id, response_id, response_revision, response_kind, response_presentation, response_card_set_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          target.turnId,
          target.ownerScopeRef,
          target.threadId,
          target.revision,
          `cancel:${target.turnId}:${target.revision}`,
          '',
          'cancelled',
          null,
          null,
          null,
          null,
          null,
          null,
        );
        return { status: 'accepted' as const };
      }
      if (row.status === 'running' || row.status === 'cancel_requested') {
        shouldCancel = true;
        this.options.storage.sql.exec(
          "UPDATE runtime_turn SET status = 'cancel_requested' WHERE thread_id = ? AND turn_id = ? AND revision = ?",
          target.threadId,
          target.turnId,
          target.revision,
        );
        return { status: 'accepted' as const };
      }
      return {
        status: row.status === 'stale' ? ('stale' as const) : ('already_finished' as const),
        ...(row.status === 'stale' ? { code: 'STALE_TURN' as const } : {}),
      };
    });
    return { result, shouldCancel };
  }
  cancelForLifecycle(
    ownerScopeRef: string,
    threadId: string,
    revision: number,
    turnId: string | null,
  ) {
    return cancelRuntimeForLifecycleRows({
      storage: this.options.storage,
      ownerScopeRef,
      threadId,
      revision,
      turnId,
    });
  }
  replayRuntimeTurn(value: unknown): ThreadRuntimeReplayResult {
    if (!isThreadRuntimeTarget(value)) return { status: 'unavailable', code: 'NOT_FOUND' };
    const target = value;
    const binding = this.bindingFor(target);
    if (binding === undefined) return { status: 'unavailable', code: 'NOT_FOUND' };
    const row = this.rowSync(target);
    if (row?.status !== 'completed' || row.response_id === null) {
      return { status: 'unavailable', code: row?.status === 'stale' ? 'STALE_TURN' : 'NOT_FOUND' };
    }
    if (
      row.response_revision === null ||
      row.response_kind === null ||
      row.response_presentation === null
    ) {
      return { status: 'unavailable', code: 'NOT_FOUND' };
    }
    return {
      status: 'reference_only',
      response: {
        turnId: row.turn_id,
        responseId: row.response_id,
        revision: row.response_revision,
        kind: row.response_kind,
        presentation: row.response_presentation,
        cardSetId: row.response_card_set_id,
        restoreMode: 'reference_only',
      },
    };
  }

  listRuntimeResponses(ownerScopeRef: string): ThreadRuntimeResponseMetadata[] {
    const binding = this.options.readBinding();
    if (binding === undefined || binding.deleted || binding.ownerScopeRef !== ownerScopeRef) {
      return [];
    }
    const rows = this.options.storage.sql
      .exec<RuntimeTurnRow>(
        `SELECT turn_id, owner_scope_ref, thread_id, revision, idempotency_key, input_digest, status, request_id, response_id, ${responseColumns} FROM runtime_turn WHERE owner_scope_ref = ? ORDER BY revision ASC, turn_id ASC`,
        ownerScopeRef,
      )
      .toArray();
    return rows.map((row) => ({
      turnId: row.turn_id,
      revision: row.response_revision ?? row.revision,
      status:
        row.status === 'running' || row.status === 'cancel_requested' ? 'cancelled' : row.status,
      responseId: row.response_id,
      kind: row.response_kind,
      presentation: row.response_presentation,
      cardSetId: row.response_card_set_id,
    }));
  }

  isStale(target: ThreadRuntimeTarget): boolean {
    return isRuntimeTargetStale(target, this.bindingFor(target), this.rowSync(target));
  }
  invalidateActive(): void {
    this.options.storage.sql.exec(
      "UPDATE runtime_turn SET status = 'stale' WHERE status IN ('running', 'cancel_requested')",
    );
  }
  clearCommitLedger(): void {
    this.options.storage.sql.exec('DELETE FROM runtime_commit');
  }
}
