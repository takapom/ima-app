export type DeadlineResult<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'timeout' | 'aborted' }
  | { readonly kind: 'rejected'; readonly error: unknown };

/** Bounds credential and response work, including fetch implementations that ignore AbortSignal. */
export const runWithinDeadline = async <T>(
  work: Promise<T>,
  deadlineAt: number,
  signal: AbortSignal | undefined,
  onTimeout?: () => void,
): Promise<DeadlineResult<T>> => {
  const settled = work.then(
    (value) => ({ kind: 'done' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
  if (signal?.aborted) return { kind: 'aborted' };
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) {
    onTimeout?.();
    return { kind: 'timeout' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), remainingMs);
  });
  const aborted = new Promise<{ readonly kind: 'aborted' }>((resolve) => {
    onAbort = () => resolve({ kind: 'aborted' });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const outcome = await Promise.race([settled, timeout, aborted]);
  if (timer !== undefined) clearTimeout(timer);
  if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  if (outcome.kind === 'timeout') onTimeout?.();
  return outcome;
};
