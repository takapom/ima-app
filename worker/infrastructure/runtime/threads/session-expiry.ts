export type RuntimeSessionExpiryGate = (onCleanupComplete?: () => void) => Promise<boolean>;

export const createRuntimeSessionExpiryGate = (input: {
  readonly isExpired: () => boolean;
  readonly readScope: () =>
    { readonly ownerScopeRef: string; readonly threadId: string } | undefined;
  readonly cleanupRuntime: () => Promise<void>;
  readonly clearContext: (scope: {
    readonly ownerScopeRef: string;
    readonly threadId: string;
  }) => void;
  readonly clearPhotos: () => Promise<void>;
}): RuntimeSessionExpiryGate => {
  let cleanupDone = false;
  return async (onCleanupComplete) => {
    let expired = false;
    try {
      expired = input.isExpired();
    } catch {
      // A broken clock/anchor is fail-closed. Run the same cleanup path so an invalid
      // durable anchor cannot leave retained runtime state behind while alarms retry.
      expired = true;
    }
    if (!expired) return false;
    if (cleanupDone) {
      try {
        onCleanupComplete?.();
      } catch {
        // A durable completion marker that cannot be written must be retried.
        return true;
      }
      return true;
    }
    let cleanupSucceeded = true;
    let scope: { readonly ownerScopeRef: string; readonly threadId: string } | undefined;
    try {
      scope = input.readScope();
    } catch {
      cleanupSucceeded = false;
    }
    try {
      await input.cleanupRuntime();
    } catch {
      // Expiry remains fail-closed when SDK cleanup needs a platform retry.
      cleanupSucceeded = false;
    }
    try {
      if (scope !== undefined) input.clearContext(scope);
    } catch {
      cleanupSucceeded = false;
    } finally {
      try {
        await input.clearPhotos();
      } catch {
        cleanupSucceeded = false;
      }
    }
    if (cleanupSucceeded) {
      try {
        onCleanupComplete?.();
      } catch {
        cleanupSucceeded = false;
      }
    }
    if (cleanupSucceeded) cleanupDone = true;
    return true;
  };
};
