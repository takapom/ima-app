export type DecisionHapticsService = {
  readonly decision: () => Promise<void> | void;
};

export type DecisionHapticsResult =
  | { readonly status: 'performed' }
  | { readonly status: 'failed'; readonly reason: 'haptics_unavailable' };

/** expo-haptics is intentionally not assumed until the native dependency gate passes. */
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
