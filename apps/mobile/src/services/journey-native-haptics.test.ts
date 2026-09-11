import { describe, expect, it, vi } from 'vitest';
import {
  createNativeDecisionHapticsService,
  type NativeJourneyHapticsModule,
} from './journey-native-haptics';
import { triggerDecisionHaptics } from './journey-haptics';

const expoHapticsMock = vi.hoisted(() => {
  const state = {
    importCount: 0,
    notificationTypes: [] as unknown[],
  };
  return {
    state,
    module: {
      NotificationFeedbackType: { Success: 'success' },
      notificationAsync: (type: unknown): Promise<void> => {
        state.notificationTypes.push(type);
        return Promise.resolve();
      },
    },
  };
});

vi.mock('expo-haptics', () => {
  expoHapticsMock.state.importCount += 1;
  return expoHapticsMock.module;
});

describe('native journey haptics service', () => {
  it('lazily imports Expo Haptics and sends one success notification per decision', async () => {
    const service = createNativeDecisionHapticsService();

    expect(expoHapticsMock.state.importCount).toBe(0);
    expect(expoHapticsMock.state.notificationTypes).toEqual([]);

    await expect(triggerDecisionHaptics(service)).resolves.toEqual({ status: 'performed' });

    expect(expoHapticsMock.state.importCount).toBe(1);
    expect(expoHapticsMock.state.notificationTypes).toEqual(['success']);
  });

  it('does no native work at construction and calls the injected module once', async () => {
    let loadCount = 0;
    let notificationCount = 0;
    const loadHaptics = (): Promise<NativeJourneyHapticsModule> => {
      loadCount += 1;
      return Promise.resolve({
        notifySuccess: (): Promise<void> => {
          notificationCount += 1;
          return Promise.resolve();
        },
      });
    };

    const service = createNativeDecisionHapticsService({ loadHaptics });
    expect(loadCount).toBe(0);
    expect(notificationCount).toBe(0);

    await service.decision();

    expect(loadCount).toBe(1);
    expect(notificationCount).toBe(1);
  });

  it('normalizes loader and native errors without exposing their messages', async () => {
    const service = createNativeDecisionHapticsService({
      loadHaptics: () => Promise.reject(new Error('secret native implementation detail')),
    });

    await expect(triggerDecisionHaptics(service)).resolves.toEqual({
      status: 'failed',
      reason: 'haptics_unavailable',
    });

    const failingNotification = createNativeDecisionHapticsService({
      loadHaptics: () =>
        Promise.resolve({
          notifySuccess: () => Promise.reject(new Error('raw SDK error')),
        }),
    });
    await expect(triggerDecisionHaptics(failingNotification)).resolves.toEqual({
      status: 'failed',
      reason: 'haptics_unavailable',
    });
  });
});
