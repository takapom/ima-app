import { describe, expect, it } from 'vitest';
import { entryLayout } from '@mobile/entry/presentation/entry-motion';

describe('entry layout', () => {
  const layout = entryLayout({ width: 390, height: 844, bottomInset: 34 });

  it('starts the dog centered near the bottom of the splash', () => {
    expect(layout.dogStart.x).toBe((390 - layout.dogSize) / 2);
    expect(layout.dogStart.y + layout.dogSize).toBeLessThan(844 - 34);
  });

  it('lands the dog above both choices on the right edge', () => {
    expect(layout.dogEnd.x + layout.dogSize).toBe(390 - layout.sidePadding);
    expect(layout.dogEnd.y + layout.dogSize).toBeLessThanOrEqual(layout.choicesTop);
    expect(layout.dogEnd.y).toBeLessThan(layout.dogStart.y);
  });

  it('moves the wordmark from the center toward the top', () => {
    expect(layout.wordmarkShift).toBeLessThan(0);
    expect(844 / 2 + layout.wordmarkShift).toBeGreaterThan(0);
  });
});
