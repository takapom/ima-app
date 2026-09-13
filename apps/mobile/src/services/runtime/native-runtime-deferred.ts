export type WaitResult<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected' }
  | { readonly status: 'timeout' }
  | { readonly status: 'aborted' };

/** Bounds native SDK work and consumes late completion/failure safely. */
export const waitFor = async <T>(
  operation: () => T | Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onLateValue?: (value: T) => void,
): Promise<WaitResult<T>> => {
  if (signal?.aborted) return { status: 'aborted' };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { status: 'timeout' };
  let finished = false;
  let resolveResult: ((result: WaitResult<T>) => void) | undefined;
  const result = new Promise<WaitResult<T>>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (next: WaitResult<T>): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    resolveResult?.(next);
  };
  const onAbort = (): void => finish({ status: 'aborted' });
  const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);

  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
    return result;
  }
  void Promise.resolve()
    .then(async () => {
      if (finished) return;
      try {
        const value = await operation();
        if (finished) {
          try {
            onLateValue?.(value);
          } catch {
            // Cleanup failure must not create an unhandled rejection.
          }
          return;
        }
        finish({ status: 'fulfilled', value });
      } catch {
        if (!finished) finish({ status: 'rejected' });
      }
    })
    .catch(() => {
      if (!finished) finish({ status: 'rejected' });
    });
  return result;
};
