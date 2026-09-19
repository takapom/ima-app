import type {
  ThreadRuntimeAdmission,
  ThreadRuntimeCancelResult,
  ThreadRuntimeReplayResult,
  ThreadRuntimeResponseMetadata,
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
  ThreadRuntimeTurnResult,
} from '@worker/runtime/threads/admission';

export type RuntimeThreadBinding = {
  readonly threadId: string;
  readonly ownerScopeRef: string;
  readonly revision: number;
  readonly active: boolean;
  readonly deleted: boolean;
};

export type RuntimeTurnAdmissionOutcome = {
  readonly admission: ThreadRuntimeAdmission;
  readonly previousActive: ThreadRuntimeTarget | undefined;
};

export interface RuntimeTurnStore {
  admit(input: ThreadRuntimeTurnInput, digest: string): RuntimeTurnAdmissionOutcome;
  status(target: ThreadRuntimeTarget): string | undefined;
  updateResult(
    target: ThreadRuntimeTarget,
    result: ThreadRuntimeTurnResult,
  ): ThreadRuntimeTurnResult;
  requestCancellation(target: ThreadRuntimeTarget): {
    result: ThreadRuntimeCancelResult;
    shouldCancel: boolean;
  };
  cancelForLifecycle(
    ownerScopeRef: string,
    threadId: string,
    revision: number,
    turnId: string | null,
  ): readonly ThreadRuntimeTarget[];
  replayRuntimeTurn(value: unknown): ThreadRuntimeReplayResult;
  listRuntimeResponses(ownerScopeRef: string): ThreadRuntimeResponseMetadata[];
  isStale(target: ThreadRuntimeTarget): boolean;
  invalidateActive(): void;
  clearCommitLedger(): void;
}
