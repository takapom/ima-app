import { describe, expect, it } from 'vitest';
import { entryLayout, jumpArc } from '@mobile/entry/presentation/entry-motion';

describe('jump arc', () => {
  const arc = jumpArc({ dx: 120, dy: -80, height: 60, steps: 8 });

  it('starts at the splash position and lands on the target', () => {
    expect(arc.input[0]).toBe(0);
    expect(arc.input.at(-1)).toBe(1);
    expect(arc.x[0]).toBe(0);
    expect(arc.y[0]).toBe(0);
    expect(arc.x.at(-1)).toBe(120);
    expect(arc.y.at(-1)).toBe(-80);
  });

  it('rises above the higher end before landing', () => {
    expect(Math.min(...arc.y)).toBeLessThanOrEqual(-80 - 60);
    expect(Math.min(...arc.y)).toBeGreaterThan(-80 - 60 - 1);
  });

  it('moves sideways at a steady pace', () => {
    expect(arc.x).toEqual([0, 15, 30, 45, 60, 75, 90, 105, 120]);
  });

  it('keeps every range the same length and increasing in input', () => {
    expect(arc.x).toHaveLength(arc.input.length);
    expect(arc.y).toHaveLength(arc.input.length);
    expect(
      arc.input.every((value, index) => index === 0 || value > (arc.input[index - 1] ?? 0)),
    ).toBe(true);
  });
});

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
