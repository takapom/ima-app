import { describe, expect, it } from 'vitest';
import {
  CAROUSEL_GAP,
  CAROUSEL_PEEK,
  carouselDots,
  carouselIndexAt,
  carouselLayout,
} from '@mobile/journey/components/candidates/candidate-carousel-model';

const EDGE = 14;

describe('candidate carousel model', () => {
  it('narrows each card so both neighbours peek in and every card stops in the middle', () => {
    const layout = carouselLayout(390, 3, EDGE);
    const sidePadding = CAROUSEL_PEEK + CAROUSEL_GAP;
    const itemWidth = 390 - sidePadding * 2;
    expect(layout).toEqual({
      itemWidth,
      sidePadding,
      gap: CAROUSEL_GAP,
      offsets: [0, itemWidth + CAROUSEL_GAP, (itemWidth + CAROUSEL_GAP) * 2],
    });
  });

  it('keeps a single card at the page edge without peeking space', () => {
    expect(carouselLayout(390, 1, EDGE)).toEqual({
      itemWidth: 390 - EDGE * 2,
      sidePadding: EDGE,
      gap: CAROUSEL_GAP,
      offsets: [0],
    });
  });

  it('lays nothing out until the strip has a width', () => {
    expect(carouselLayout(0, 3, EDGE)).toEqual({
      itemWidth: 0,
      sidePadding: CAROUSEL_PEEK + CAROUSEL_GAP,
      gap: CAROUSEL_GAP,
      offsets: [],
    });
    expect(carouselLayout(Number.NaN, 3, EDGE).offsets).toEqual([]);
  });

  it('never gives a card a negative width on a very narrow strip', () => {
    expect(carouselLayout(20, 2, EDGE).itemWidth).toBe(0);
  });

  it('picks the card whose stop is nearest to the scroll position', () => {
    const layout = carouselLayout(390, 3, EDGE);
    const step = layout.itemWidth + layout.gap;
    expect(carouselIndexAt(0, layout)).toBe(0);
    expect(carouselIndexAt(step - 10, layout)).toBe(1);
    expect(carouselIndexAt(step * 1.5 - 1, layout)).toBe(1);
    expect(carouselIndexAt(step * 1.5 + 1, layout)).toBe(2);
  });

  it('stays on the first and last card when the strip bounces past either end', () => {
    const layout = carouselLayout(390, 3, EDGE);
    expect(carouselIndexAt(-60, layout)).toBe(0);
    expect(carouselIndexAt(10_000, layout)).toBe(2);
  });

  it('reads the first card before the strip is laid out', () => {
    expect(carouselIndexAt(120, carouselLayout(0, 3, EDGE))).toBe(0);
  });

  it('marks the current card among the position markers and names each target', () => {
    expect(carouselDots(3, 1)).toEqual([
      { index: 0, active: false, accessibilityLabel: '3件中1件目を表示' },
      { index: 1, active: true, accessibilityLabel: '3件中2件目を表示' },
      { index: 2, active: false, accessibilityLabel: '3件中3件目を表示' },
    ]);
  });

  it('shows no position markers for a single card', () => {
    expect(carouselDots(1, 0)).toEqual([]);
    expect(carouselDots(0, 0)).toEqual([]);
  });
});
