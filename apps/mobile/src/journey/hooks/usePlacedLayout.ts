import { useCallback, useEffect, useRef } from 'react';
import { Platform, type LayoutChangeEvent, type View } from 'react-native';
import type { CardSetFocus } from '@mobile/journey/state/card-set-focus';
import { placedLayoutReactions } from '@mobile/journey/state/placed-layout';

const REACTIONS = placedLayoutReactions(Platform.OS);

/** A view's place in its parent, as onLayout reports it. */
export type PlacedLayout = {
  readonly y: number;
  readonly height: number;
};

/**
 * Hands a view's place in its parent to `onPlace`. Native onLayout already fires when only the
 * position changes; on web it fires only when the view resizes, so there the view measures itself
 * again whenever the transcript content moves, and announces its own resizes so the views below
 * it do the same. `onPlace` must keep its identity across renders.
 */
export function usePlacedLayout(
  focus: CardSetFocus | undefined,
  onPlace: (layout: PlacedLayout) => void,
) {
  const ref = useRef<View>(null);
  useEffect(() => {
    if (!REACTIONS.measureOnMove || focus === undefined) return undefined;
    return focus.watchMoves(() => {
      ref.current?.measure((_x, y, _width, height) => {
        if (Number.isFinite(y) && Number.isFinite(height)) onPlace({ y, height });
      });
    });
  }, [focus, onPlace]);
  const onLayout = useCallback(
    ({ nativeEvent }: LayoutChangeEvent) => {
      onPlace(nativeEvent.layout);
      if (REACTIONS.announceResize) focus?.contentMoved();
    },
    [focus, onPlace],
  );
  return { ref, onLayout };
}
