import type { PublicCard } from '@ima/contracts';

export type CardSetRange = {
  readonly top: number;
  readonly bottom: number;
};

export type CardSetFocusEntry = {
  readonly cards: readonly PublicCard[];
  readonly index: number;
  readonly range: CardSetRange | null;
};

export type FocusedCard = {
  readonly id: string;
  readonly card: PublicCard;
  readonly index: number;
  readonly count: number;
};

export type CardSetFocus = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly current: () => FocusedCard | null;
  /** Visible part of the transcript, without the area the companion covers. */
  readonly update: (top: number, height: number) => void;
  readonly register: (id: string, cards: readonly PublicCard[]) => () => void;
  readonly setRange: (id: string, range: CardSetRange | null) => void;
  readonly setIndex: (id: string, index: number) => void;
};

// An answer peeking in at an edge (e.g. under the app bar) is not what the reader is looking at.
const MIN_VISIBLE_HEIGHT = 96;

const visibleEnough = (range: CardSetRange, visible: CardSetRange): boolean =>
  Math.min(range.bottom, visible.bottom) - Math.max(range.top, visible.top) >=
  Math.max(1, Math.min(MIN_VISIBLE_HEIGHT, range.bottom - range.top));

const distanceFrom = (point: number, range: CardSetRange): number =>
  point < range.top ? range.top - point : point > range.bottom ? point - range.bottom : 0;

/** The answer the reader is looking at: the visible one nearest the middle, newer on a tie. */
export const focusedCard = (
  entries: ReadonlyMap<string, CardSetFocusEntry>,
  visible: CardSetRange | null,
): FocusedCard | null => {
  if (visible === null) return null;
  const middle = (visible.top + visible.bottom) / 2;
  let best: { id: string; entry: CardSetFocusEntry; distance: number; top: number } | null = null;
  for (const [id, entry] of entries) {
    const range = entry.range;
    if (range === null || entry.cards.length === 0) continue;
    if (!visibleEnough(range, visible)) continue;
    const distance = distanceFrom(middle, range);
    if (
      best === null ||
      distance < best.distance ||
      (distance === best.distance && range.top > best.top)
    ) {
      best = { id, entry, distance, top: range.top };
    }
  }
  if (best === null) return null;
  const index = Math.max(0, Math.min(best.entry.index, best.entry.cards.length - 1));
  const card = best.entry.cards[index];
  return card === undefined ? null : { id: best.id, card, index, count: best.entry.cards.length };
};

const sameFocus = (a: FocusedCard | null, b: FocusedCard | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.id === b.id &&
    a.card === b.card &&
    a.index === b.index &&
    a.count === b.count);

export const createCardSetFocus = (): CardSetFocus => {
  const entries = new Map<string, CardSetFocusEntry>();
  const listeners = new Set<() => void>();
  let visible: CardSetRange | null = null;
  let snapshot: FocusedCard | null = null;

  const refresh = (): void => {
    const next = focusedCard(entries, visible);
    if (sameFocus(snapshot, next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const patch = (id: string, change: Partial<CardSetFocusEntry>): void => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    entries.set(id, { ...entry, ...change });
    refresh();
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current: () => snapshot,
    update: (top, height) => {
      if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return;
      visible = { top: Math.max(0, top), bottom: Math.max(0, top) + height };
      refresh();
    },
    register: (id, cards) => {
      const entry = entries.get(id);
      entries.set(id, { cards, index: entry?.index ?? 0, range: entry?.range ?? null });
      refresh();
      return () => {
        entries.delete(id);
        refresh();
      };
    },
    setRange: (id, range) => patch(id, { range }),
    setIndex: (id, index) => patch(id, { index }),
  };
};
