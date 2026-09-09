import type { RuntimeThinkConnection } from '../runtime/runtime-think-connection';
import type { ThreadRuntimeTarget } from './admission';

type LifecycleRuntimeRow = Pick<
  ThreadRuntimeTarget,
  'ownerScopeRef' | 'threadId' | 'turnId' | 'revision'
> & {
  readonly status: string;
};

type LifecycleCancellationOptions = {
  readonly storage: DurableObjectStorage;
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly revision: number;
  readonly turnId: string | null;
  readonly activeTarget: ThreadRuntimeTarget | undefined;
  readonly getConnection: () => RuntimeThinkConnection<unknown> | undefined;
};

/**
 * Invalidates runtime rows before notifying a live connection after a lifecycle CAS. A missing
 * row is valid because lifecycle cancellation can precede runtime admission.
 */
export const cancelRuntimeForLifecycle = ({
  storage,
  ownerScopeRef,
  threadId,
  revision,
  turnId,
  activeTarget,
  getConnection,
}: LifecycleCancellationOptions): void => {
  const activeTargets = storage.transactionSync(() => {
    const rows =
      turnId === null
        ? storage.sql
            .exec<LifecycleRuntimeRow>(
              'SELECT owner_scope_ref AS ownerScopeRef, thread_id AS threadId, turn_id AS turnId, revision, status FROM runtime_turn WHERE owner_scope_ref = ? AND thread_id = ? AND revision = ?',
              ownerScopeRef,
              threadId,
              revision,
            )
            .toArray()
        : storage.sql
            .exec<LifecycleRuntimeRow>(
              'SELECT owner_scope_ref AS ownerScopeRef, thread_id AS threadId, turn_id AS turnId, revision, status FROM runtime_turn WHERE owner_scope_ref = ? AND thread_id = ? AND revision = ? AND turn_id = ?',
              ownerScopeRef,
              threadId,
              revision,
              turnId,
            )
            .toArray();
    const active = rows.filter(
      (row) => row.status === 'running' || row.status === 'cancel_requested',
    );
    for (const row of active) {
      storage.sql.exec(
        "UPDATE runtime_turn SET status = 'cancel_requested' WHERE thread_id = ? AND turn_id = ? AND revision = ? AND status IN ('running', 'cancel_requested')",
        row.threadId,
        row.turnId,
        row.revision,
      );
    }
    return active;
  });
  if (
    activeTarget !== undefined &&
    activeTargets.some(
      (target) =>
        target.ownerScopeRef === activeTarget.ownerScopeRef &&
        target.threadId === activeTarget.threadId &&
        target.turnId === activeTarget.turnId &&
        target.revision === activeTarget.revision,
    )
  ) {
    getConnection()?.cancel();
  }
};
