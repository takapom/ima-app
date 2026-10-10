/** Visible part of each neighbouring card, so the strip reads as swipeable. */
export const CAROUSEL_PEEK = 16;
export const CAROUSEL_GAP = 8;

export type CarouselLayout = {
  readonly itemWidth: number;
  readonly sidePadding: number;
  readonly gap: number;
  /** Scroll positions where each card sits in the middle of the strip. */
  readonly offsets: readonly number[];
};

export type CarouselDot = {
  readonly index: number;
  readonly active: boolean;
  readonly accessibilityLabel: string;
};

export const carouselLayout = (
  viewportWidth: number,
  count: number,
  edge: number,
): CarouselLayout => {
  const sidePadding = count > 1 ? CAROUSEL_PEEK + CAROUSEL_GAP : edge;
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return { itemWidth: 0, sidePadding, gap: CAROUSEL_GAP, offsets: [] };
  }
  const itemWidth = Math.max(0, viewportWidth - sidePadding * 2);
  return {
    itemWidth,
    sidePadding,
    gap: CAROUSEL_GAP,
    offsets: Array.from({ length: count }, (_, index) => index * (itemWidth + CAROUSEL_GAP)),
  };
};

export const carouselIndexAt = (offset: number, layout: CarouselLayout): number =>
  layout.offsets.reduce(
    (nearest, stop, index) =>
      Math.abs(stop - offset) < Math.abs((layout.offsets[nearest] ?? 0) - offset) ? index : nearest,
    0,
  );

export const carouselDots = (count: number, activeIndex: number): readonly CarouselDot[] =>
  count <= 1
    ? []
    : Array.from({ length: count }, (_, index) => ({
        index,
        active: index === activeIndex,
        accessibilityLabel: `${count}件中${index + 1}件目を表示`,
      }));
