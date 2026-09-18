export type RuntimeDispatchTarget = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: number;
};

export type RuntimeDispatchOptions<Result> = {
  /** The serializable server-owned identity bound to one owner/thread/turn/revision. */
  readonly target: RuntimeDispatchTarget;
  readonly run: () => Promise<Result>;
  /**
   * The server-side RPC receives only `target`, records cancellation even before admission, and
   * never receives the HTTP signal. The implementation may close over the same target for auth.
   */
  readonly cancel: (target: RuntimeDispatchTarget) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Optional Worker lifetime hook for cancellation RPC completion. */
  readonly waitUntil?: (promise: Promise<void>) => void;
  /** Required observation path for cancel RPC and waitUntil registration failures. */
  readonly onCancellationError: (error: unknown) => void;
};

export class RuntimeDispatchError extends Error {
  readonly code = 'CANCELLED' as const;

  constructor() {
    super('runtime dispatch cancelled before admission');
    this.name = 'RuntimeDispatchError';
  }
}

/**
 * Runs one HTTP-to-DO operation and owns its cancellation lifecycle. The run promise remains the
 * source of its result and errors; cancellation RPC failures are reported and never replace it.
 * Cancellation is observed asynchronously, with `waitUntil` available to extend Worker lifetime;
 * dispatch never waits indefinitely for cancellation to settle.
 */
export const dispatchRuntimeRequest = async <Result>(
  options: RuntimeDispatchOptions<Result>,
): Promise<Result> => {
  let settled = false;
  let cancellation: Promise<void> | undefined;

  const cancelOnce = (): Promise<void> => {
    if (cancellation !== undefined) return cancellation;
    let requested: Promise<void>;
    try {
      requested = Promise.resolve(options.cancel(options.target));
    } catch (error: unknown) {
      requested = Promise.resolve().then(() => {
        throw error;
      });
    }
    cancellation = requested.catch((error: unknown) => {
      options.onCancellationError(error);
    });
    if (options.waitUntil !== undefined) {
      try {
        options.waitUntil(cancellation);
      } catch (error: unknown) {
        options.onCancellationError(error);
      }
    }
    return cancellation;
  };

  const onAbort = (): void => {
    if (!settled) cancelOnce().catch(options.onCancellationError);
  };

  if (options.signal?.aborted === true) {
    settled = true;
    cancelOnce().catch(options.onCancellationError);
    throw new RuntimeDispatchError();
  }

  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await options.run();
    return result;
  } finally {
    settled = true;
    options.signal?.removeEventListener('abort', onAbort);
  }
};
