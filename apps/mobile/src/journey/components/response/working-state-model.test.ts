import { describe, expect, it } from 'vitest';
import {
  WORKING_SKELETON_CARDS,
  workingSkeletonMotion,
} from '@mobile/journey/components/response/working-state-model';

describe('working state skeleton', () => {
  it('reserves the same three slots that a proposal can fill', () => {
    expect(WORKING_SKELETON_CARDS).toHaveLength(3);
    expect(new Set(WORKING_SKELETON_CARDS.map((card) => card.key)).size).toBe(3);
  });

  it('gives every slot a name and the three fact lines of a candidate card', () => {
    for (const card of WORKING_SKELETON_CARDS) {
      expect(card.nameWidth).toMatch(/^\d{2}%$/);
      expect(card.factWidths).toHaveLength(3);
    }
    expect(new Set(WORKING_SKELETON_CARDS.map((card) => card.nameWidth)).size).toBe(3);
  });

  it('pulses only when reduced motion is known to be off', () => {
    expect(workingSkeletonMotion(false)).toBe('pulse');
    expect(workingSkeletonMotion(true)).toBe('still');
    expect(workingSkeletonMotion(null)).toBe('still');
  });
});
