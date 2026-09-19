import { describe, expect, it } from 'vitest';
import { scaleForDynamicType } from '@mobile/ui/theme/tokens';

describe('mobile dynamic type layout helpers', () => {
  it('keeps normal metrics at or below the default font scale', () => {
    expect(scaleForDynamicType(96, 0.9)).toBe(96);
    expect(scaleForDynamicType(96, 1)).toBe(96);
  });

  it('grows bounded input and visual regions with larger font scales', () => {
    expect(scaleForDynamicType(96, 1.5)).toBe(144);
    expect(scaleForDynamicType(168, 2)).toBe(336);
  });

  it('keeps expanding the layout when system text exceeds two times', () => {
    expect(scaleForDynamicType(96, 3)).toBe(288);
  });
});
