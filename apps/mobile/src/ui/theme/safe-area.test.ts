import { describe, expect, it } from 'vitest';
import { keyboardOffsetForSafeArea, paddingWithSafeArea } from '@mobile/ui/theme/safe-area';

describe('safe-area layout boundaries', () => {
  it('adds the top or bottom device inset to the intentional spacing', () => {
    expect(paddingWithSafeArea(8, 47)).toBe(55);
    expect(paddingWithSafeArea(12, 34)).toBe(46);
  });

  it('does not let malformed negative insets remove intentional spacing', () => {
    expect(paddingWithSafeArea(12, -1)).toBe(12);
    expect(keyboardOffsetForSafeArea(-1)).toBe(0);
  });

  it('keeps the keyboard gap from counting the home indicator twice', () => {
    const keyboardFrameHeight = 300;
    const bottomInset = 34;
    const composerBasePadding = 12;
    const keyboardPadding = keyboardFrameHeight + keyboardOffsetForSafeArea(bottomInset);
    const composerPadding = paddingWithSafeArea(composerBasePadding, bottomInset);

    expect(keyboardPadding + composerPadding).toBe(keyboardFrameHeight + composerBasePadding);
  });
});
