import type { DecisionHapticsService } from './journey-haptics';

/**
 * The native module is reduced to the one operation this action needs. Keeping
 * the Expo import behind this loader lets hosts test the boundary without
 * importing native-only code during module construction.
 */
export type NativeJourneyHapticsModule = {
  readonly notifySuccess: () => Promise<void>;
};

export type NativeJourneyHapticsOptions = {
  readonly loadHaptics?: () => Promise<NativeJourneyHapticsModule>;
};

const loadExpoHaptics = async (): Promise<NativeJourneyHapticsModule> => {
  const haptics = await import('expo-haptics');
  return {
    notifySuccess: () => haptics.notificationAsync(haptics.NotificationFeedbackType.Success),
  };
};

/**
 * Creates the native decision feedback service without doing native I/O.
 * `notifySuccess` completing means the SDK accepted the request; it cannot
 * prove that a particular device physically emitted a vibration.
 */
export const createNativeDecisionHapticsService = (
  options: NativeJourneyHapticsOptions = {},
): DecisionHapticsService => {
  const loadHaptics = options.loadHaptics ?? loadExpoHaptics;
  return {
    decision: async () => {
      const haptics = await loadHaptics();
      await haptics.notifySuccess();
    },
  };
};
