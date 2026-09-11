export type DecisionHapticsService = {
  readonly decision: () => Promise<void> | void;
};

export type DecisionHapticsResult =
  | { readonly status: 'performed' }
  | { readonly status: 'failed'; readonly reason: 'haptics_unavailable' };

/** Explicit unavailable service for hosts that intentionally disable native haptics. */
export const createUnavailableDecisionHapticsService = (): DecisionHapticsService => ({
  decision: () => {
    throw new Error('haptics dependency is not installed');
  },
});

export const triggerDecisionHaptics = async (
  service: DecisionHapticsService,
): Promise<DecisionHapticsResult> => {
  try {
    await service.decision();
    return { status: 'performed' };
  } catch {
    return { status: 'failed', reason: 'haptics_unavailable' };
  }
};
