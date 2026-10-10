import { describe, expect, it } from 'vitest';
import { jumpArc } from '@mobile/ui/presentation/jump-arc';

describe('jump arc', () => {
  const arc = jumpArc({ dx: 120, dy: -80, height: 60, steps: 8 });

  it('starts where the dog stands and lands on the target', () => {
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
