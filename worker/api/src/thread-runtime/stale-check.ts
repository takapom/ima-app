import type { ThreadRuntimeTarget } from '@api/thread-runtime/admission';

type RuntimeStaleBinding = {
  readonly revision: number;
  readonly active: boolean;
};

type RuntimeStaleRow = {
  readonly status: 'running' | 'cancel_requested' | 'cancelled' | 'stale' | 'completed' | 'failed';
  readonly response_revision: number | null;
};

export const isRuntimeTargetStale = (
  target: ThreadRuntimeTarget,
  binding: RuntimeStaleBinding | undefined,
  row: RuntimeStaleRow | undefined,
): boolean => {
  const selfFinalized =
    binding !== undefined &&
    target.revision < Number.MAX_SAFE_INTEGER &&
    binding.revision === target.revision + 1 &&
    row?.status === 'completed' &&
    row.response_revision === target.revision + 1;
  if (binding === undefined || (!selfFinalized && binding.revision !== target.revision)) {
    return true;
  }
  if (!binding.active) return true;
  return (
    row === undefined ||
    row.status === 'stale' ||
    row.status === 'cancel_requested' ||
    row.status === 'cancelled'
  );
};
