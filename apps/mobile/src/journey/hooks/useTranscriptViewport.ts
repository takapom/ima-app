import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
} from 'react-native';
import { createCardSetFocus } from '@mobile/journey/state/card-set-focus';
import { createHistoryPhotoViewport } from '@mobile/journey/state/history-photo-viewport';

const FOLLOW_LATEST_SLACK = 80;

/**
 * Tracks which part of the transcript is on screen: history photos load only there, and the
 * companion talks about the answer in view. The companion covers the bottom of the transcript, so
 * that strip is kept free below the content and passed on as the covered height.
 */
export function useTranscriptViewport({
  followOnGrowth,
  initialCompanionSpace,
}: {
  readonly followOnGrowth: boolean;
  readonly initialCompanionSpace: number;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const followsLatest = useRef(true);
  const photoViewport = useMemo(createHistoryPhotoViewport, []);
  const cardFocus = useMemo(createCardSetFocus, []);
  const viewportHeight = useRef(0);
  const contentHeight = useRef(0);
  const scrollTop = useRef(0);
  const [companionSpace, setCompanionSpace] = useState(initialCompanionSpace);

  const publish = (): void => {
    photoViewport.update(scrollTop.current, viewportHeight.current);
    cardFocus.update(scrollTop.current, viewportHeight.current, companionSpace);
  };

  useEffect(() => {
    cardFocus.update(scrollTop.current, viewportHeight.current, companionSpace);
  }, [cardFocus, companionSpace]);

  return {
    photoViewport,
    cardFocus,
    companionSpace,
    onCompanionLayout: ({ nativeEvent }: LayoutChangeEvent): void => {
      setCompanionSpace(Math.max(initialCompanionSpace, Math.ceil(nativeEvent.layout.height)));
    },
    scrollProps: {
      ref: scrollRef,
      scrollEventThrottle: 32,
      onLayout: ({ nativeEvent }: LayoutChangeEvent): void => {
        viewportHeight.current = nativeEvent.layout.height;
        if (contentHeight.current <= 0) return;
        if (followsLatest.current)
          scrollTop.current = Math.max(0, contentHeight.current - viewportHeight.current);
        publish();
      },
      onScroll: ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>): void => {
        scrollTop.current = nativeEvent.contentOffset.y;
        viewportHeight.current = nativeEvent.layoutMeasurement.height;
        contentHeight.current = nativeEvent.contentSize.height;
        followsLatest.current =
          nativeEvent.contentSize.height -
            nativeEvent.layoutMeasurement.height -
            nativeEvent.contentOffset.y <
          FOLLOW_LATEST_SLACK;
        publish();
      },
      onContentSizeChange: (_width: number, height: number): void => {
        contentHeight.current = height;
        if (followOnGrowth && followsLatest.current) {
          scrollTop.current = Math.max(0, height - viewportHeight.current);
          publish();
          scrollRef.current?.scrollToEnd({ animated: false });
        } else {
          publish();
        }
      },
    },
  };
}
