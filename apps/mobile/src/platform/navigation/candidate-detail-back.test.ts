import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeCandidateDetailBack } from '@mobile/platform/navigation/candidate-detail-back';

const native = vi.hoisted(() => ({
  platform: { OS: 'web' },
  addEventListener: vi.fn<(event: string, listener: () => boolean) => { remove: () => void }>(),
}));

vi.mock('react-native', () => ({
  Platform: native.platform,
  BackHandler: { addEventListener: native.addEventListener },
}));

beforeEach(() => {
  native.platform.OS = 'web';
  native.addEventListener.mockReset();
});

describe('candidate detail hardware back subscription', () => {
  it.each(['web', 'ios'])('never calls the unsupported BackHandler on %s', (platform) => {
    native.platform.OS = platform;
    native.addEventListener.mockImplementation(() => {
      throw new Error('BackHandler is not supported on this platform');
    });
    const close = vi.fn();
    expect(subscribeCandidateDetailBack(close)).toBeUndefined();
    expect(native.addEventListener).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes the sheet, consumes Android back, and removes the listener during cleanup', () => {
    native.platform.OS = 'android';
    const remove = vi.fn();
    native.addEventListener.mockReturnValue({ remove });
    const close = vi.fn();
    const cleanup = subscribeCandidateDetailBack(close);
    expect(native.addEventListener).toHaveBeenCalledExactlyOnceWith(
      'hardwareBackPress',
      expect.any(Function),
    );
    expect(close).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    const listener = native.addEventListener.mock.calls[0]?.[1];
    if (listener === undefined || cleanup === undefined) throw new Error('subscription required');
    expect(listener()).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    cleanup();
    expect(remove).toHaveBeenCalledOnce();
  });
});
