export type RuntimeSessionExpiryGate = () => Promise<boolean>;

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
  return async () => {
    let expired = false;
    try {
      expired = input.isExpired();
    } catch {
      return true;
    }
    if (!expired) return false;
    if (cleanupDone) return true;
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
    if (cleanupSucceeded) cleanupDone = true;
    return true;
  };
};
