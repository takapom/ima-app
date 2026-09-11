export type DecisionHapticsService = {
  readonly decision: () => Promise<void> | void;
};

export type DecisionHapticsResult =
  | { readonly status: 'performed' }
  | { readonly status: 'failed'; readonly reason: 'haptics_unavailable' };

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
