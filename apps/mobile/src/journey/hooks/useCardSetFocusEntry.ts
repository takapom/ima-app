import { useCallback, useEffect } from 'react';
import type { PublicCard } from '@ima/contracts';
import type { CardSetFocus, CardSetRange } from '@mobile/journey/state/card-set-focus';

/**
 * Tells the companion where one answer sits in the transcript and which of its cards is in the
 * middle of the strip. The entry lives as long as the answer is mounted; card updates keep the
 * swiped position.
 */
export function useCardSetFocusEntry(
  focus: CardSetFocus | undefined,
  id: string,
  cards: readonly PublicCard[],
  range: CardSetRange | null,
): (index: number) => void {
  useEffect(() => focus?.register(id, []), [focus, id]);
  useEffect(() => {
    focus?.setCards(id, cards);
  }, [focus, id, cards]);
  useEffect(() => {
    focus?.setRange(id, range);
  }, [focus, id, range]);
  return useCallback((index: number) => focus?.setIndex(id, index), [focus, id]);
}
