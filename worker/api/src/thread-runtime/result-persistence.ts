import {
  responseMetadata,
  runtimeFailure,
  type ThreadRuntimeRunStatus,
  type ThreadRuntimeFailureCode,
  type ThreadRuntimeTarget,
  type ThreadRuntimeTurnResult,
} from '@api/thread-runtime/admission';

type RuntimeTurnStorageStatus =
  'running' | 'cancel_requested' | 'cancelled' | 'stale' | 'completed' | 'failed';

type RuntimeTurnStatusRow = {
  readonly status: RuntimeTurnStorageStatus;
  readonly response_id: string | null;
  readonly response_revision: number | null;
  readonly response_kind: 'message' | 'cards' | null;
  readonly response_presentation: 'keep' | 'replace' | null;
  readonly response_card_set_id: string | null;
};

type PersistenceOutcome = {
  readonly status: ThreadRuntimeRunStatus;
  readonly committed: boolean;
  readonly failureCode: ThreadRuntimeFailureCode | null;
};

export type RuntimeResultPersistenceOptions = {
  readonly storage: DurableObjectStorage;
  readonly target: ThreadRuntimeTarget;
  readonly result: ThreadRuntimeTurnResult;
  /** Test-only compatibility hook for a non-durable CommitPort fixture. */
  readonly commitResponse?: (target: ThreadRuntimeTarget, revision: number) => boolean;
};

/** Stores only validated response metadata; the response body remains the RPC result. */
export const persistRuntimeResult = (
  options: RuntimeResultPersistenceOptions,
): ThreadRuntimeTurnResult => {
  const { target, result } = options;
  const metadata = result.status === 'completed' ? responseMetadata(result.response, target) : null;
  const validCompletion = result.status === 'completed' && metadata !== null;
  const requestedFailureCode: ThreadRuntimeFailureCode =
    result.status === 'cancelled'
      ? 'CANCELLED'
      : result.status === 'stale'
        ? 'STALE_TURN'
        : (result.code ?? 'RUNTIME_FAILED');
  const outcome = options.storage.transactionSync((): PersistenceOutcome => {
    const row = options.storage.sql
      .exec<RuntimeTurnStatusRow>(
        'SELECT status, response_id, response_revision, response_kind, response_presentation, response_card_set_id FROM runtime_turn WHERE thread_id = ? AND turn_id = ? AND revision = ?',
        target.threadId,
        target.turnId,
        target.revision,
      )
      .toArray()[0];
    const rowStatus = row?.status;
    const cancellationWon = rowStatus === 'cancel_requested' || rowStatus === 'cancelled';
    const staleWon = rowStatus === 'stale';

    if (
      validCompletion &&
      rowStatus === 'completed' &&
      metadata !== null &&
      row?.response_id === metadata.responseId &&
      row.response_revision === metadata.revision &&
      row.response_kind === metadata.kind &&
      row.response_presentation === metadata.presentation &&
      (metadata.kind !== 'cards' ||
        row.response_card_set_id === null ||
        row.response_card_set_id === metadata.cardSetId)
    ) {
      options.storage.sql.exec(
        "UPDATE runtime_turn SET request_id = ?, response_card_set_id = ? WHERE thread_id = ? AND turn_id = ? AND revision = ? AND status = 'completed' AND response_id = ? AND response_revision = ?",
        result.requestId,
        metadata.cardSetId,
        target.threadId,
        target.turnId,
        target.revision,
        metadata.responseId,
        metadata.revision,
      );
      return { status: 'completed', committed: true, failureCode: null };
    }

    if (validCompletion && rowStatus === 'running' && metadata !== null) {
      const committed = options.commitResponse?.(target, metadata.revision) ?? false;
      const status: ThreadRuntimeRunStatus = committed ? 'completed' : 'stale';
      options.storage.sql.exec(
        "UPDATE runtime_turn SET status = ?, request_id = ?, response_id = ?, response_revision = ?, response_kind = ?, response_presentation = ?, response_card_set_id = ? WHERE thread_id = ? AND turn_id = ? AND revision = ? AND status = 'running'",
        status,
        result.requestId,
        committed ? metadata.responseId : null,
        committed ? metadata.revision : null,
        committed ? metadata.kind : null,
        committed ? metadata.presentation : null,
        committed ? metadata.cardSetId : null,
        target.threadId,
        target.turnId,
        target.revision,
      );
      return {
        status,
        committed,
        failureCode: committed ? null : 'STALE_TURN',
      };
    }

    const failureCode: ThreadRuntimeFailureCode = cancellationWon
      ? 'CANCELLED'
      : staleWon || (validCompletion && rowStatus !== 'running')
        ? 'STALE_TURN'
        : validCompletion
          ? 'RUNTIME_FAILED'
          : requestedFailureCode;
    const status: ThreadRuntimeRunStatus =
      failureCode === 'CANCELLED' ? 'cancelled' : failureCode === 'STALE_TURN' ? 'stale' : 'failed';
    const expectedStatus = rowStatus === 'cancel_requested' ? 'cancel_requested' : 'running';
    if (rowStatus === 'running' || rowStatus === 'cancel_requested') {
      options.storage.sql.exec(
        'UPDATE runtime_turn SET status = ?, request_id = ?, response_id = NULL, response_revision = NULL, response_kind = NULL, response_presentation = NULL, response_card_set_id = NULL WHERE thread_id = ? AND turn_id = ? AND revision = ? AND status = ?',
        status,
        result.requestId,
        target.threadId,
        target.turnId,
        target.revision,
        expectedStatus,
      );
    }
    return { status, committed: false, failureCode };
  });
  if (outcome.status === 'completed' && outcome.committed) return result;
  if (outcome.failureCode === 'STALE_TURN') {
    return runtimeFailure('STALE_TURN', result.requestId);
  }
  if (outcome.failureCode === 'CANCELLED') {
    return runtimeFailure('CANCELLED', result.requestId);
  }
  if (outcome.failureCode !== null) return runtimeFailure(outcome.failureCode, result.requestId);
  return runtimeFailure('RUNTIME_FAILED', result.requestId);
};
