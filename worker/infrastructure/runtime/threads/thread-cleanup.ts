type RuntimeCleanup = {
  readonly cleanupRuntime: () => Promise<void>;
  readonly clearContext: () => void;
  readonly clearPhotos: () => Promise<void>;
};

/** Runs deletion cleanup independently so one failed surface cannot skip the others. */
export const cleanupRuntimeResources = async (input: RuntimeCleanup): Promise<void> => {
  let firstError: unknown;
  try {
    await input.cleanupRuntime();
  } catch (error: unknown) {
    firstError = error;
  }
  try {
    input.clearContext();
  } catch (error: unknown) {
    firstError ??= error;
  }
  try {
    await input.clearPhotos();
  } catch (error: unknown) {
    firstError ??= error;
  }
  if (firstError !== undefined) {
    throw firstError instanceof Error ? firstError : new Error('RUNTIME_CLEANUP_FAILED');
  }
};
