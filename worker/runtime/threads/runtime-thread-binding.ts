import type { RuntimeThreadBinding } from '@worker/runtime/threads/controller';

type RuntimeThreadBindingRow = {
  readonly thread_id: string;
  readonly owner_scope_ref: string;
  readonly revision: number;
  readonly active: number;
  readonly deleted: number;
};

export const runtimeThreadBindingFor = (
  row: RuntimeThreadBindingRow | undefined,
): RuntimeThreadBinding | undefined =>
  row === undefined
    ? undefined
    : {
        threadId: row.thread_id,
        ownerScopeRef: row.owner_scope_ref,
        revision: row.revision,
        active: row.active === 1,
        deleted: row.deleted === 1,
      };
