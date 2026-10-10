import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { PublicCard } from '@ima/contracts';
import {
  carouselDots,
  carouselIndexAt,
  carouselLayout,
} from '@mobile/journey/components/candidates/candidate-carousel-model';
import { colors, spacing } from '@mobile/ui/theme/tokens';

// react-native-web ignores snapToOffsets, so the strip settles itself once scrolling stops.
const WEB_SETTLE_MS = 140;

/** One answer's candidates side by side; the card in the middle is the one being looked at. */
export function CandidateCarousel({
  cards,
  renderCard,
  onIndexChange,
}: {
  readonly cards: readonly PublicCard[];
  readonly renderCard: (card: PublicCard, index: number) => ReactNode;
  readonly onIndexChange?: (index: number) => void;
}): React.JSX.Element {
  const scrollRef = useRef<ScrollView>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [width, setWidth] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const activeIndex = Math.max(0, Math.min(selectedIndex, cards.length - 1));
  const layout = carouselLayout(width, cards.length, spacing.page);
  const dots = carouselDots(cards.length, activeIndex);

  useEffect(
    () => () => {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    },
    [],
  );

  const scrollTo = (index: number): void => {
    scrollRef.current?.scrollTo({ x: layout.offsets[index] ?? 0, y: 0, animated: true });
  };

  return (
    <View style={styles.strip}>
      <ScrollView
        ref={scrollRef}
        horizontal
        decelerationRate="fast"
        disableIntervalMomentum
        snapToOffsets={[...layout.offsets]}
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={32}
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        onScroll={({ nativeEvent }) => {
          const index = carouselIndexAt(nativeEvent.contentOffset.x, layout);
          if (index !== activeIndex) {
            setSelectedIndex(index);
            onIndexChange?.(index);
          }
          if (Platform.OS !== 'web') return;
          if (settleTimer.current !== null) clearTimeout(settleTimer.current);
          settleTimer.current = setTimeout(() => scrollTo(index), WEB_SETTLE_MS);
        }}
        contentContainerStyle={[
          styles.track,
          { gap: layout.gap, paddingHorizontal: layout.sidePadding },
        ]}
      >
        {layout.itemWidth > 0
          ? cards.map((card, index) => (
              <View key={card.candidateId} style={{ width: layout.itemWidth }}>
                {renderCard(card, index)}
              </View>
            ))
          : null}
      </ScrollView>
      {dots.length === 0 ? null : (
        <View style={styles.dots}>
          {dots.map((dot) => (
            <Pressable
              key={dot.index}
              accessibilityLabel={dot.accessibilityLabel}
              accessibilityRole="button"
              accessibilityState={{ selected: dot.active }}
              hitSlop={12}
              onPress={() => scrollTo(dot.index)}
              style={styles.dotTarget}
            >
              <View style={[styles.dot, dot.active && styles.dotActive]} />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { gap: spacing.compact, marginHorizontal: -spacing.page },
  track: { alignItems: 'stretch' },
  dots: { flexDirection: 'row', justifyContent: 'center' },
  dotTarget: { paddingHorizontal: 3, paddingVertical: 6 },
  dot: { backgroundColor: colors.border, borderRadius: 3, height: 5, width: 26 },
  dotActive: { backgroundColor: colors.lime, width: 44 },
});
