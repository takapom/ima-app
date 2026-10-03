export type HistoryPhotoRange = {
  readonly top: number;
  readonly bottom: number;
};

export type HistoryPhotoViewport = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly visible: (range: HistoryPhotoRange | null) => boolean;
  readonly update: (top: number, height: number) => void;
};

export const rangesIntersect = (
  viewport: HistoryPhotoRange | null,
  range: HistoryPhotoRange | null,
): boolean =>
  viewport !== null && range !== null && range.bottom > viewport.top && range.top < viewport.bottom;

export const createHistoryPhotoViewport = (): HistoryPhotoViewport => {
  let viewport: HistoryPhotoRange | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visible: (range) => rangesIntersect(viewport, range),
    update: (top, height) => {
      if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return;
      const next = { top: Math.max(0, top), bottom: Math.max(0, top) + height };
      if (viewport?.top === next.top && viewport.bottom === next.bottom) return;
      viewport = next;
      for (const listener of listeners) listener();
    },
  };
};
