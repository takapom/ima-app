export type RuntimeSingleFlightFailureCode = 'CANCELLED' | 'STALE_TURN' | 'CALL_ID_CONFLICT';

export class RuntimeSingleFlightError extends Error {
  readonly code: RuntimeSingleFlightFailureCode;

  constructor(code: RuntimeSingleFlightFailureCode) {
    super(`single-flight request ${code.toLowerCase()}`);
    this.name = 'RuntimeSingleFlightError';
    this.code = code;
  }
}

export type RuntimeSingleFlightOptions = {
  readonly isCancelled?: () => boolean;
  readonly isStale?: () => boolean;
};

type Entry<T> = {
  readonly key: string;
  readonly promise: Promise<T>;
};

/**
 * Keeps one read promise per turn. The maps are deliberately in-memory and must be disposed
 * with the turn; they are not a cache or a persistence path for provider content.
 */
export class RuntimeSingleFlight<T> {
  private readonly byKey = new Map<string, Entry<T>>();
  private readonly byCallId = new Map<string, Entry<T>>();
  private readonly isCancelled: () => boolean;
  private readonly isStale: () => boolean;
  private disposed = false;

  constructor(options: RuntimeSingleFlightOptions = {}) {
    this.isCancelled = options.isCancelled ?? (() => false);
    this.isStale = options.isStale ?? (() => false);
  }

  execute(callId: string, key: string, task: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new RuntimeSingleFlightError('CANCELLED'));
    if (this.isStale()) return Promise.reject(new RuntimeSingleFlightError('STALE_TURN'));
    if (this.isCancelled()) return Promise.reject(new RuntimeSingleFlightError('CANCELLED'));
    const priorCall = this.byCallId.get(callId);
    if (priorCall !== undefined) {
      if (priorCall.key !== key)
        return Promise.reject(new RuntimeSingleFlightError('CALL_ID_CONFLICT'));
      return priorCall.promise;
    }

    const priorKey = this.byKey.get(key);
    if (priorKey !== undefined) {
      this.byCallId.set(callId, priorKey);
      return priorKey.promise;
    }

    const promise = Promise.resolve().then(() => {
      if (this.disposed) throw new RuntimeSingleFlightError('CANCELLED');
      if (this.isStale()) throw new RuntimeSingleFlightError('STALE_TURN');
      if (this.isCancelled()) throw new RuntimeSingleFlightError('CANCELLED');
      return task();
    });
    const entry: Entry<T> = { key, promise };
    this.byKey.set(key, entry);
    this.byCallId.set(callId, entry);
    const clearInFlightKey = (): void => {
      if (this.byKey.get(key) === entry) this.byKey.delete(key);
    };
    void promise.then(clearInFlightKey, clearInFlightKey);
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    this.byKey.clear();
    this.byCallId.clear();
  }
}
