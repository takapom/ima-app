import type { ThreadSnapshot, ThreadState } from '@api/thread-types';

export type ThreadRow = {
  readonly thread_id: string;
  readonly owner_scope_ref: string;
  readonly revision: number;
  readonly active: number;
  readonly state: string;
  readonly deleted: number;
};

export type ThreadOperationRow = {
  readonly idempotency_key: string;
  readonly owner_scope_ref: string;
  readonly action: string;
  readonly turn_id: string | null;
  readonly expected_revision: number;
  readonly result_revision: number;
  readonly result_active: number;
  readonly result_state: string;
};

export type ThreadAction = Exclude<ThreadState, 'active'>;

export const isThreadState = (value: string): value is ThreadState =>
  value === 'active' ||
  value === 'cancelled' ||
  value === 'ended' ||
  value === 'restarted' ||
  value === 'resumed';

export const stateOf = (value: string): ThreadState => {
  if (isThreadState(value)) return value;
  throw new Error('THREAD_STATE_CORRUPT');
};

export const snapshotFromOperation = (
  row: ThreadRow,
  operation: ThreadOperationRow,
): ThreadSnapshot => ({
  threadId: row.thread_id,
  ownerScopeRef: row.owner_scope_ref,
  revision: operation.result_revision,
  active: operation.result_active === 1,
  state: stateOf(operation.result_state),
});
