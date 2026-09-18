import type { RuntimeTurnStore } from '@worker/infrastructure/runtime/ports/turn-store';
export type { RuntimeThreadBinding } from '@worker/infrastructure/runtime/ports/turn-store';
import { type RuntimeThinkConnection } from '@worker/infrastructure/runtime/turn-execution/runtime-think-connection';
import {
  cancelledRuntimeResult,
  isThreadRuntimeTarget,
  isThreadRuntimeTurnInput,
  runtimeInputDigest,
  runtimeFailure,
  type ThreadRuntimeCancelResult,
  type ThreadRuntimeReplayResult,
  type ThreadRuntimeResponseMetadata,
  type ThreadRuntimeTarget,
  type ThreadRuntimeTurnInput,
  type ThreadRuntimeTurnResult,
} from '@worker/infrastructure/runtime/threads/admission';
import { runtimeResultForError } from '@worker/infrastructure/runtime/threads/controller-errors';

export type ThreadRuntimeControllerOptions = {
  readonly store: RuntimeTurnStore;
  readonly ready: () => Promise<void>;
  readonly getConnection: () => RuntimeThinkConnection<unknown> | undefined;
  readonly execute: (
    input: ThreadRuntimeTurnInput,
    target: ThreadRuntimeTarget,
    isStale: () => boolean,
  ) => Promise<ThreadRuntimeTurnResult>;
  readonly onFinalResult?: (
    target: ThreadRuntimeTarget,
    result: ThreadRuntimeTurnResult,
    durationMs?: number,
  ) => void;
  readonly clearMessages: () => Promise<void>;
};

/** Owns only per-thread runtime admission and metadata; Think remains the model loop owner. */
export class ThreadRuntimeController {
  private activeTarget: ThreadRuntimeTarget | undefined;
  private activeRun: Promise<ThreadRuntimeTurnResult> | undefined;

  constructor(private readonly options: ThreadRuntimeControllerOptions) {}

  private notifyFinalResult(
    target: ThreadRuntimeTarget,
    result: ThreadRuntimeTurnResult,
    startedAtMs: number,
  ): void {
    const elapsed = performance.now() - startedAtMs;
    const durationMs =
      Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 600_000
        ? Math.round(elapsed)
        : undefined;
    try {
      this.options.onFinalResult?.(target, result, durationMs);
    } catch {
      // Runtime observation is best effort and cannot change the persisted result.
    }
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
    const admission = this.options.store.admit(input, inputDigest);
    if (admission.admission.status !== 'admitted') return admission.admission.result;
    await this.waitForInvalidatedTurn(admission.previousActive);
    const target: ThreadRuntimeTarget = input;
    const startedAtMs = performance.now();
    const admittedStatus = this.options.store.status(input);
    if (this.isStale(input)) {
      const result =
        admittedStatus === 'cancelled' || admittedStatus === 'cancel_requested'
          ? cancelledRuntimeResult()
          : runtimeFailure('STALE_TURN');
      const finalResult = this.options.store.updateResult(input, result);
      this.notifyFinalResult(target, finalResult, startedAtMs);
      return finalResult;
    }
    const connection = this.options.getConnection();
    if (connection === undefined) {
      const result = runtimeFailure('RUNTIME_UNCONFIGURED');
      const finalResult = this.options.store.updateResult(input, result);
      this.notifyFinalResult(target, finalResult, startedAtMs);
      return finalResult;
    }
    this.activeTarget = target;
    const run = this.options.execute(input, target, () => this.isStale(target));
    this.activeRun = run;
    let result: ThreadRuntimeTurnResult | undefined;
    let unexpectedError: unknown;
    let hasUnexpectedError = false;
    try {
      result = await run;
    } catch (error: unknown) {
      const mapped = runtimeResultForError(error);
      if (mapped !== undefined) result = mapped;
      else {
        result = runtimeFailure('RUNTIME_FAILED');
        unexpectedError = error;
        hasUnexpectedError = true;
      }
    } finally {
      result = this.options.store.updateResult(target, result ?? runtimeFailure('RUNTIME_FAILED'));
      this.notifyFinalResult(target, result, startedAtMs);
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
    const { result, shouldCancel } = this.options.store.requestCancellation(target);
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
    const targets = this.options.store.cancelForLifecycle(
      ownerScopeRef,
      threadId,
      revision,
      turnId,
    );
    const active = this.activeTarget;
    if (
      active !== undefined &&
      targets.some(
        (target) =>
          target.ownerScopeRef === active.ownerScopeRef &&
          target.threadId === active.threadId &&
          target.turnId === active.turnId &&
          target.revision === active.revision,
      )
    )
      this.options.getConnection()?.cancel();
  }
  async replayRuntimeTurn(value: unknown): Promise<ThreadRuntimeReplayResult> {
    if (!isThreadRuntimeTarget(value)) return { status: 'unavailable', code: 'NOT_FOUND' };
    await this.options.ready();
    return this.options.store.replayRuntimeTurn(value);
  }
  async listRuntimeResponses(ownerScopeRef: string): Promise<ThreadRuntimeResponseMetadata[]> {
    await this.options.ready();
    return this.options.store.listRuntimeResponses(ownerScopeRef);
  }
  isStale(target: ThreadRuntimeTarget): boolean {
    return this.options.store.isStale(target);
  }

  async cleanupForDelete(): Promise<void> {
    this.options.store.invalidateActive();
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
    if (cleanupError === undefined) {
      try {
        // Preserve the ledger until a failed cleanup can be retried.
        this.options.store.clearCommitLedger();
      } catch (error: unknown) {
        cleanupError = error;
      }
    }
    this.activeTarget = undefined;
    this.activeRun = undefined;
    if (cleanupError !== undefined)
      throw cleanupError instanceof Error ? cleanupError : new Error('runtime cleanup failed');
  }
}
