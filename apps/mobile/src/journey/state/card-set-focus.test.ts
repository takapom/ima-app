import { describe, expect, it, vi } from 'vitest';
import type { PublicCard } from '@ima/contracts';
import {
  createCardSetFocus,
  focusedCard,
  type CardSetFocusEntry,
} from '@mobile/journey/state/card-set-focus';

const card = (candidateId: string): PublicCard => ({
  candidateId,
  facts: { identity: { status: 'unknown', reason: 'fixture' } },
  why: {
    text: `${candidateId}の理由`,
    retention: {
      retentionDecision: 'deny',
      retentionMode: 'session_only',
      sessionExpiresAt: '2026-10-07T00:00:00Z',
      freshUntil: '2026-10-07T00:00:00Z',
      displayUntil: '2026-10-07T00:00:00Z',
      retentionUntil: null,
      deletionScheduledAt: null,
      attribution: null,
      restoreMode: 'reference_only',
      policyStatus: 'policy_withheld',
      displayPolicyStatus: 'available',
    },
  },
});

const older = [card('a1'), card('a2'), card('a3')];
const newer = [card('b1'), card('b2')];

const entries = (
  ...items: (readonly [string, CardSetFocusEntry])[]
): ReadonlyMap<string, CardSetFocusEntry> => new Map(items);

describe('focused card', () => {
  const both = entries(
    ['older', { cards: older, index: 1, range: { top: 0, bottom: 400 } }],
    ['newer', { cards: newer, index: 0, range: { top: 600, bottom: 1000 } }],
  );

  it('takes the answer that covers the middle of the visible area, at its current card', () => {
    expect(focusedCard(both, { top: 0, bottom: 500 })).toEqual({
      id: 'older',
      card: older[1],
      index: 1,
      count: 3,
      latest: false,
    });
    expect(focusedCard(both, { top: 500, bottom: 1000 })?.card).toBe(newer[0]);
  });

  it('tells whether the answer in view is the newest one in the conversation', () => {
    expect(focusedCard(both, { top: 0, bottom: 500 })?.latest).toBe(false);
    expect(focusedCard(both, { top: 500, bottom: 1000 })?.latest).toBe(true);
    const alone = entries(['older', { cards: older, index: 0, range: { top: 0, bottom: 400 } }]);
    expect(focusedCard(alone, { top: 0, bottom: 400 })?.latest).toBe(true);
  });

  it('takes the visible answer nearest to the middle when none covers it', () => {
    expect(focusedCard(both, { top: 200, bottom: 760 })?.id).toBe('older');
    expect(focusedCard(both, { top: 300, bottom: 840 })?.id).toBe('newer');
  });

  it('prefers the newer answer when two are equally near the middle', () => {
    expect(focusedCard(both, { top: 300, bottom: 700 })?.id).toBe('newer');
  });

  it('says nothing when no answer is on screen or the screen is not measured yet', () => {
    expect(focusedCard(both, { top: 420, bottom: 580 })).toBeNull();
    expect(focusedCard(both, null)).toBeNull();
    expect(focusedCard(new Map(), { top: 0, bottom: 800 })).toBeNull();
  });

  it('does not count an answer that only peeks in at the edge of the screen', () => {
    expect(focusedCard(both, { top: 390, bottom: 1000 })?.id).toBe('newer');
    const olderOnly = entries([
      'older',
      { cards: older, index: 0, range: { top: 0, bottom: 400 } },
    ]);
    expect(focusedCard(olderOnly, { top: 390, bottom: 900 })).toBeNull();
    expect(focusedCard(olderOnly, { top: 300, bottom: 900 })?.id).toBe('older');
  });

  it('still counts a short answer that is fully on screen', () => {
    const short = entries(['short', { cards: newer, index: 0, range: { top: 500, bottom: 540 } }]);
    expect(focusedCard(short, { top: 0, bottom: 900 })?.id).toBe('short');
  });

  it('ignores answers whose position is not measured yet', () => {
    const unmeasured = entries(['older', { cards: older, index: 0, range: null }]);
    expect(focusedCard(unmeasured, { top: 0, bottom: 800 })).toBeNull();
  });

  it('stays on the last card when the answer lost cards after its index was set', () => {
    const shrunk = entries(['older', { cards: older, index: 7, range: { top: 0, bottom: 400 } }]);
    expect(focusedCard(shrunk, { top: 0, bottom: 400 })).toMatchObject({
      index: 2,
      card: older[2],
    });
  });

  it('has nothing to say about an answer without cards', () => {
    const empty = entries(['older', { cards: [], index: 0, range: { top: 0, bottom: 400 } }]);
    expect(focusedCard(empty, { top: 0, bottom: 400 })).toBeNull();
  });
});

describe('focused card under the companion', () => {
  const low = entries(['low', { cards: older, index: 0, range: { top: 330, bottom: 630 } }]);

  it('picks an answer only when enough of it shows above the companion', () => {
    expect(focusedCard(low, { top: 0, bottom: 500, cover: 64 })?.id).toBe('low');
    expect(focusedCard(low, { top: 0, bottom: 500, cover: 132 })).toBeNull();
  });

  it('keeps the answer it is talking about while its own bubble grows over it', () => {
    expect(focusedCard(low, { top: 0, bottom: 500, cover: 132 }, 'low')?.id).toBe('low');
  });

  it('lets go of the answer once it is scrolled out of view, even while talking about it', () => {
    expect(focusedCard(low, { top: 600, bottom: 1100, cover: 64 }, 'low')).toBeNull();
  });

  it('measures the middle on the whole screen, so the bubble never moves it', () => {
    const pair = entries(
      ['upper', { cards: older, index: 0, range: { top: 0, bottom: 240 } }],
      ['lower', { cards: newer, index: 0, range: { top: 260, bottom: 500 } }],
    );
    expect(focusedCard(pair, { top: 0, bottom: 500, cover: 0 }, 'lower')?.id).toBe('lower');
    expect(focusedCard(pair, { top: 0, bottom: 500, cover: 132 }, 'lower')?.id).toBe('lower');
  });
});

describe('card set focus store', () => {
  it('does not drop or re-pick an answer when only the companion changes height', () => {
    const focus = createCardSetFocus();
    const listener = vi.fn();
    focus.subscribe(listener);
    focus.register('low', older);
    focus.setRange('low', { top: 330, bottom: 630 });
    focus.update(0, 500, 64);
    const talking = focus.current();
    expect(talking?.id).toBe('low');
    focus.update(0, 500, 132);
    focus.update(0, 500, 64);
    focus.update(0, 500, 132);
    expect(focus.current()).toBe(talking);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the strip that registered last when an older strip with the same id goes away', () => {
    const focus = createCardSetFocus();
    const removeFirst = focus.register('answer', older);
    focus.setRange('answer', { top: 0, bottom: 400 });
    focus.update(0, 400);
    const removeSecond = focus.register('answer', newer);
    expect(focus.current()?.card).toBe(newer[0]);
    removeFirst();
    expect(focus.current()?.card).toBe(newer[0]);
    removeSecond();
    expect(focus.current()).toBeNull();
  });

  it('swaps the cards of an answer without losing the swiped position', () => {
    const focus = createCardSetFocus();
    focus.register('answer', []);
    focus.setRange('answer', { top: 0, bottom: 400 });
    focus.update(0, 400);
    focus.setCards('answer', older);
    focus.setIndex('answer', 2);
    expect(focus.current()?.card).toBe(older[2]);
    focus.setCards('answer', [...older]);
    expect(focus.current()?.index).toBe(2);
    focus.setCards('missing', newer);
    expect(focus.current()?.card).toBe(older[2]);
  });

  it('follows registration, layout, swipes, scrolling and removal', () => {
    const focus = createCardSetFocus();
    expect(focus.current()).toBeNull();

    const unregister = focus.register('older', older);
    focus.setRange('older', { top: 0, bottom: 400 });
    focus.update(0, 500);
    expect(focus.current()?.card).toBe(older[0]);

    focus.setIndex('older', 2);
    expect(focus.current()?.card).toBe(older[2]);

    focus.register('newer', newer);
    focus.setRange('newer', { top: 600, bottom: 1000 });
    focus.update(500, 500);
    expect(focus.current()?.card).toBe(newer[0]);

    focus.update(0, 500);
    expect(focus.current()?.card).toBe(older[2]);
    unregister();
    expect(focus.current()).toBeNull();
  });

  it('keeps the swiped card when the same answer registers again with its cards', () => {
    const focus = createCardSetFocus();
    focus.register('older', older);
    focus.setRange('older', { top: 0, bottom: 400 });
    focus.setIndex('older', 1);
    focus.update(0, 400);
    focus.register('older', older);
    expect(focus.current()?.index).toBe(1);
  });

  it('notifies only when the focused card changes and keeps the same snapshot otherwise', () => {
    const focus = createCardSetFocus();
    const listener = vi.fn();
    focus.subscribe(listener);
    focus.register('older', older);
    focus.setRange('older', { top: 0, bottom: 400 });
    focus.update(0, 400);
    const snapshot = focus.current();
    expect(listener).toHaveBeenCalledTimes(1);

    focus.update(10, 400);
    focus.setRange('older', { top: 0, bottom: 420 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(focus.current()).toBe(snapshot);

    focus.setIndex('older', 1);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores a visible area that is not measured', () => {
    const focus = createCardSetFocus();
    focus.register('older', older);
    focus.setRange('older', { top: 0, bottom: 400 });
    focus.update(0, 0);
    focus.update(Number.NaN, 400);
    expect(focus.current()).toBeNull();
  });

  it('stops notifying after unsubscribing', () => {
    const focus = createCardSetFocus();
    const listener = vi.fn();
    const unsubscribe = focus.subscribe(listener);
    unsubscribe();
    focus.register('older', older);
    focus.setRange('older', { top: 0, bottom: 400 });
    focus.update(0, 400);
    expect(listener).not.toHaveBeenCalled();
  });
});
