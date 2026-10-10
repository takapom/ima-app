import type { PublicCard } from '@ima/contracts';

export type CardSetRange = {
  readonly top: number;
  readonly bottom: number;
};

/** The visible part of the transcript; `cover` is the height the companion hides at its bottom. */
export type CardSetView = CardSetRange & {
  readonly cover?: number;
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
  /** True when no measured answer sits below this one in the conversation. */
  readonly latest: boolean;
};

export type CardSetFocus = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly current: () => FocusedCard | null;
  /** Visible part of the transcript and the height the companion covers at its bottom. */
  readonly update: (top: number, height: number, cover?: number) => void;
  /** Adds an answer; the returned removal only removes this registration, not a later one. */
  readonly register: (id: string, cards: readonly PublicCard[]) => () => void;
  readonly setCards: (id: string, cards: readonly PublicCard[]) => void;
  /**
   * Web reports onLayout only when a view resizes, so an answer pushed down by content above keeps
   * its old place. The transcript calls `contentMoved` when its content resizes, and answers
   * watching for moves measure their place again.
   */
  readonly watchMoves: (listener: () => void) => () => void;
  readonly contentMoved: () => void;
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

/**
 * The answer the reader is looking at: the visible one nearest the middle, newer on a tie. A new
 * answer must show enough above the companion; the one already `holding` the bubble stays while
 * it shows enough on screen, so the bubble's own height never takes it away or brings it back.
 */
export const focusedCard = (
  entries: ReadonlyMap<string, CardSetFocusEntry>,
  view: CardSetView | null,
  holding: string | null = null,
): FocusedCard | null => {
  if (view === null) return null;
  const screen = { top: view.top, bottom: view.bottom };
  const uncovered = { top: view.top, bottom: view.bottom - Math.max(0, view.cover ?? 0) };
  const middle = (screen.top + screen.bottom) / 2;
  let best: { id: string; entry: CardSetFocusEntry; distance: number; top: number } | null = null;
  let newestTop = Number.NEGATIVE_INFINITY;
  for (const [id, entry] of entries) {
    const range = entry.range;
    if (range === null || entry.cards.length === 0) continue;
    newestTop = Math.max(newestTop, range.top);
    if (!visibleEnough(range, id === holding ? screen : uncovered)) continue;
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
  return card === undefined
    ? null
    : {
        id: best.id,
        card,
        index,
        count: best.entry.cards.length,
        latest: best.top >= newestTop,
      };
};

const sameFocus = (a: FocusedCard | null, b: FocusedCard | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.id === b.id &&
    a.card === b.card &&
    a.index === b.index &&
    a.count === b.count &&
    a.latest === b.latest);

export const createCardSetFocus = (): CardSetFocus => {
  const entries = new Map<string, CardSetFocusEntry>();
  const listeners = new Set<() => void>();
  const owners = new Map<string, symbol>();
  const moveListeners = new Set<() => void>();
  let view: CardSetView | null = null;
  let snapshot: FocusedCard | null = null;

  const refresh = (): void => {
    const next = focusedCard(entries, view, snapshot?.id ?? null);
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
    update: (top, height, cover = 0) => {
      if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return;
      const start = Math.max(0, top);
      view = {
        top: start,
        bottom: start + height,
        cover: Number.isFinite(cover) ? Math.min(Math.max(0, cover), height) : 0,
      };
      refresh();
    },
    register: (id, cards) => {
      const owner = Symbol(id);
      const entry = entries.get(id);
      owners.set(id, owner);
      entries.set(id, { cards, index: entry?.index ?? 0, range: entry?.range ?? null });
      refresh();
      return () => {
        if (owners.get(id) !== owner) return;
        owners.delete(id);
        entries.delete(id);
        refresh();
      };
    },
    setCards: (id, cards) => patch(id, { cards }),
    watchMoves: (listener) => {
      moveListeners.add(listener);
      return () => {
        moveListeners.delete(listener);
      };
    },
    contentMoved: () => {
      for (const listener of moveListeners) listener();
    },
    setRange: (id, range) => patch(id, { range }),
    setIndex: (id, index) => patch(id, { index }),
  };
};
