/** Keeps fixed UI spacing and device safe-area spacing additive and non-negative. */
export const paddingWithSafeArea = (base: number, inset: number): number =>
  base + Math.max(0, inset);

/**
 * KeyboardAvoidingView adds its offset to the keyboard padding. A negative offset cancels the
 * bottom inset that Composer adds for the home indicator, so the keyboard gap is counted once.
 */
export const keyboardOffsetForSafeArea = (bottomInset: number): number => {
  const inset = Math.max(0, bottomInset);
  return inset === 0 ? 0 : -inset;
};
