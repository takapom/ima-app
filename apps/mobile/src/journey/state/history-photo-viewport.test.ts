import { describe, expect, it, vi } from 'vitest';
import {
  createHistoryPhotoViewport,
  rangesIntersect,
} from '@mobile/journey/state/history-photo-viewport';

describe('history photo viewport', () => {
  it('loads only rows intersecting the viewport', () => {
    expect(rangesIntersect({ top: 100, bottom: 300 }, { top: 99, bottom: 101 })).toBe(true);
    expect(rangesIntersect({ top: 100, bottom: 300 }, { top: 299, bottom: 301 })).toBe(true);
    expect(rangesIntersect({ top: 100, bottom: 300 }, { top: 0, bottom: 100 })).toBe(false);
    expect(rangesIntersect({ top: 100, bottom: 300 }, { top: 300, bottom: 400 })).toBe(false);
    expect(rangesIntersect(null, { top: 100, bottom: 200 })).toBe(false);
  });

  it('notifies subscribers when scrolling or resizing changes the viewport', () => {
    const viewport = createHistoryPhotoViewport();
    const listener = vi.fn();
    const unsubscribe = viewport.subscribe(listener);
    const row = { top: 200, bottom: 260 };
    expect(viewport.visible(row)).toBe(false);
    viewport.update(0, 180);
    expect(viewport.visible(row)).toBe(false);
    viewport.update(180, 200);
    expect(viewport.visible(row)).toBe(true);
    viewport.update(180, 200);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    viewport.update(400, 200);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('projects 75 mounted photos to visible card groups across initial end, prepend, and resize', () => {
    const viewport = createHistoryPhotoViewport();
    const groups = Array.from({ length: 25 }, (_, index) => ({
      id: index,
      range: { top: index * 200, bottom: (index + 1) * 200 },
      photos: [`${index}-hero`, `${index}-alt-1`, `${index}-alt-2`],
    }));
    const loadTargets = (mounted: readonly (typeof groups)[number][]): readonly string[] =>
      mounted.flatMap((group) => (viewport.visible(group.range) ? group.photos : []));

    // The transcript is fully mounted, but the initial scroll-to-end viewport loads only its tail.
    viewport.update(4_400, 600);
    expect(groups.flatMap((group) => group.photos)).toHaveLength(75);
    expect(loadTargets(groups)).toEqual([
      '22-hero',
      '22-alt-1',
      '22-alt-2',
      '23-hero',
      '23-alt-1',
      '23-alt-2',
      '24-hero',
      '24-alt-1',
      '24-alt-2',
    ]);

    // Five older groups inserted before the mounted rows shift their content coordinates.
    const prepended = groups.map((group) => ({
      ...group,
      range: { top: group.range.top + 1_000, bottom: group.range.bottom + 1_000 },
    }));
    expect(loadTargets(prepended).map((photo) => photo.split('-')[0])).toEqual([
      '17',
      '17',
      '17',
      '18',
      '18',
      '18',
      '19',
      '19',
      '19',
    ]);

    // A taller viewport makes the newly intersecting groups eligible without loading every row.
    viewport.update(4_000, 800);
    expect(loadTargets(groups).map((photo) => photo.split('-')[0])).toEqual([
      '20',
      '20',
      '20',
      '21',
      '21',
      '21',
      '22',
      '22',
      '22',
      '23',
      '23',
      '23',
    ]);
  });
});
