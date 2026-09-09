import {
  isRuntimeThinkConnectionError,
  type RuntimeThinkConnection,
} from '../runtime/runtime-think-connection';
import {
  cancelledRuntimeResult,
  isThreadRuntimeTarget,
  isThreadRuntimeTurnInput,
  runtimeInputDigest,
  runtimeFailure,
  type ThreadRuntimeAdmission,
  type ThreadRuntimeCancelResult,
  type ThreadRuntimeReplayResult,
  type ThreadRuntimeResponseMetadata,
  type ThreadRuntimeTarget,
  type ThreadRuntimeTurnInput,
  type ThreadRuntimeTurnResult,
  type ThreadRuntimeFailureCode,
} from './admission';
import { persistRuntimeResult } from './result-persistence';
import { cancelRuntimeForLifecycle as cancelRuntimeForLifecycleRows } from './lifecycle-cancel';
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
export type RuntimeThreadBinding = {
  readonly threadId: string;
  readonly ownerScopeRef: string;
  readonly revision: number;
  readonly active: boolean;
  readonly deleted: boolean;
};
export type ThreadRuntimeControllerOptions = {
  readonly storage: DurableObjectStorage;
  readonly ready: () => Promise<void>;
  readonly readBinding: () => RuntimeThreadBinding | undefined;
  readonly getConnection: () => RuntimeThinkConnection<unknown> | undefined;
  readonly execute: (
    input: ThreadRuntimeTurnInput,
    target: ThreadRuntimeTarget,
    isStale: () => boolean,
  ) => Promise<ThreadRuntimeTurnResult>;
  readonly commitResponse?: (target: ThreadRuntimeTarget, revision: number) => boolean;
  readonly clearMessages: () => Promise<void>;
};
type AdmissionOutcome = {
  readonly admission: ThreadRuntimeAdmission;
  readonly previousActive: ThreadRuntimeTarget | undefined;
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

const runtimeErrorCode = (error: unknown): ThreadRuntimeFailureCode => {
  if (isRuntimeThinkConnectionError(error)) {
    switch (error.code) {
      case 'CANCELLED':
        return 'CANCELLED';
      case 'STALE_TURN':
        return 'STALE_TURN';
      case 'TURN_ALREADY_ACTIVE':
        return 'TURN_ALREADY_ACTIVE';
      case 'RUNTIME_UNCONFIGURED':
        return 'RUNTIME_UNCONFIGURED';
      case 'TURN_NOT_ACTIVE':
      case 'COMPOSITION_INVALID':
        return 'RUNTIME_FAILED';
      default:
        return 'RUNTIME_FAILED';
    }
  }
  return 'RUNTIME_FAILED';
};

const resultForError = (error: unknown): ThreadRuntimeTurnResult =>
  runtimeFailure(runtimeErrorCode(error));

const responseColumns =
  'response_revision, response_kind, response_presentation, response_card_set_id';

/** Owns only per-thread runtime admission and metadata; Think remains the model loop owner. */
export class ThreadRuntimeController {
  private activeTarget: ThreadRuntimeTarget | undefined;
  private activeRun: Promise<ThreadRuntimeTurnResult> | undefined;

  constructor(private readonly options: ThreadRuntimeControllerOptions) {}

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

  private admit(input: ThreadRuntimeTurnInput, inputDigest: string): AdmissionOutcome {
    const target: ThreadRuntimeTarget = input;
    const result = this.options.storage.transactionSync(() => {
      const binding = this.bindingFor(target);
      if (binding === undefined) return runtimeFailure('NOT_FOUND');
      if (binding.revision !== target.revision || !binding.active) {
        return runtimeFailure('STALE_TURN');
      }
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

  private updateResult(
    target: ThreadRuntimeTarget,
    result: ThreadRuntimeTurnResult,
  ): ThreadRuntimeTurnResult {
    return persistRuntimeResult({ ...this.options, target, result });
  }

  private async waitForInvalidatedTurn(previous: ThreadRuntimeTarget | undefined): Promise<void> {
    if (previous === undefined) return;
    if (
      this.activeTarget === undefined ||
      this.activeTarget.ownerScopeRef !== previous.ownerScopeRef ||
      this.activeTarget.threadId !== previous.threadId ||
      this.activeTarget.turnId !== previous.turnId ||
      this.activeTarget.revision !== previous.revision
    ) {
      return;
    }
    this.options.getConnection()?.cancel();
    const pending = this.activeRun;
    if (pending !== undefined) {
      try {
        await pending;
      } catch {
        // The prior caller already observes this failure; a newer turn must not inherit it.
      }
    }
  }

  async runRuntimeTurn(value: unknown): Promise<ThreadRuntimeTurnResult> {
    if (!isThreadRuntimeTurnInput(value)) return runtimeFailure('INVALID_ARGUMENT');
    await this.options.ready();
    const input = value;
    const inputDigest = await runtimeInputDigest(input.input);
    const admission = this.admit(input, inputDigest);
    if (admission.admission.status !== 'admitted') return admission.admission.result;
    await this.waitForInvalidatedTurn(admission.previousActive);
    const admittedRow = this.rowSync(input);
    if (this.isStale(input)) {
      const result =
        admittedRow?.status === 'cancelled' || admittedRow?.status === 'cancel_requested'
          ? cancelledRuntimeResult()
          : runtimeFailure('STALE_TURN');
      this.updateResult(input, result);
      return result;
    }
    const connection = this.options.getConnection();
    if (connection === undefined) {
      const result = runtimeFailure('RUNTIME_UNCONFIGURED');
      this.updateResult(input, result);
      return result;
    }
    const target: ThreadRuntimeTarget = input;
    this.activeTarget = target;
    const run = this.options.execute(input, target, () => this.isStale(target));
    this.activeRun = run;
    let result: ThreadRuntimeTurnResult | undefined;
    let unexpectedError: unknown;
    let hasUnexpectedError = false;
    try {
      result = await run;
    } catch (error: unknown) {
      if (isRuntimeThinkConnectionError(error)) {
        result = resultForError(error);
      } else {
        result = runtimeFailure('RUNTIME_FAILED');
        unexpectedError = error;
        hasUnexpectedError = true;
      }
    } finally {
      result = this.updateResult(target, result ?? runtimeFailure('RUNTIME_FAILED'));
      if (
        this.activeTarget?.ownerScopeRef === target.ownerScopeRef &&
        this.activeTarget.threadId === target.threadId &&
        this.activeTarget.turnId === target.turnId &&
        this.activeTarget.revision === target.revision
      ) {
        this.activeTarget = undefined;
        this.activeRun = undefined;
      }
    }
    if (hasUnexpectedError) throw unexpectedError;
    return result ?? runtimeFailure('RUNTIME_FAILED');
  }

  async cancelRuntimeTurn(value: unknown): Promise<ThreadRuntimeCancelResult> {
    if (!isThreadRuntimeTarget(value)) return { status: 'rejected', code: 'INVALID_ARGUMENT' };
    await this.options.ready();
    const target = value;
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
    if (
      shouldCancel &&
      this.activeTarget?.ownerScopeRef === target.ownerScopeRef &&
      this.activeTarget.threadId === target.threadId &&
      this.activeTarget.turnId === target.turnId &&
      this.activeTarget.revision === target.revision
    ) {
      this.options.getConnection()?.cancel();
    }
    return result;
  }

  cancelRuntimeForLifecycle(
    ownerScopeRef: string,
    threadId: string,
    revision: number,
    turnId: string | null,
  ): void {
    cancelRuntimeForLifecycleRows({
      storage: this.options.storage,
      ownerScopeRef,
      threadId,
      revision,
      turnId,
      activeTarget: this.activeTarget,
      getConnection: this.options.getConnection,
    });
  }

  async replayRuntimeTurn(value: unknown): Promise<ThreadRuntimeReplayResult> {
    if (!isThreadRuntimeTarget(value)) return { status: 'unavailable', code: 'NOT_FOUND' };
    await this.options.ready();
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

  async listRuntimeResponses(ownerScopeRef: string): Promise<ThreadRuntimeResponseMetadata[]> {
    await this.options.ready();
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
    const binding = this.bindingFor(target);
    if (binding === undefined || binding.revision !== target.revision || !binding.active)
      return true;
    const row = this.rowSync(target);
    return (
      row === undefined ||
      row.status === 'stale' ||
      row.status === 'cancel_requested' ||
      row.status === 'cancelled'
    );
  }

  async cleanupForDelete(): Promise<void> {
    this.options.storage.sql.exec(
      "UPDATE runtime_turn SET status = 'stale' WHERE status IN ('running', 'cancel_requested')",
    );
    let cleanupError: unknown;
    try {
      this.options.getConnection()?.cancel();
    } catch (error: unknown) {
      cleanupError = error;
    }
    const pending = this.activeRun;
    if (pending !== undefined) {
      try {
        await pending;
      } catch (error: unknown) {
        cleanupError ??= error;
      }
    }
    try {
      await this.options.clearMessages();
    } catch (error: unknown) {
      cleanupError ??= error;
    }
    this.activeTarget = undefined;
    this.activeRun = undefined;
    if (cleanupError !== undefined)
      throw cleanupError instanceof Error ? cleanupError : new Error('runtime cleanup failed');
  }
}
