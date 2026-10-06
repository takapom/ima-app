import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Animated, Platform, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import maruBreath from '../../../../assets/character/maru-breath.gif';
import maruDecided from '../../../../assets/character/maru-decided.png';
import maruEmpty from '../../../../assets/character/maru-empty.png';
import maruOops from '../../../../assets/character/maru-oops.png';
import maruRun from '../../../../assets/character/maru-run.gif';
import { companionSpeech } from '@mobile/journey/components/companion/companion-speech';
import type { CardSetFocus } from '@mobile/journey/state/card-set-focus';
import { companionPose, type CompanionPose } from '@mobile/journey/state/companion-pose';
import type { JourneyPhase } from '@mobile/journey/state/journey-shell';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

const NATIVE_DRIVER = Platform.OS !== 'web';
const DOG_SIZE = 64;
const SOURCES: Record<CompanionPose, number> = {
  idle: maruBreath,
  search: maruRun,
  notFound: maruEmpty,
  oops: maruOops,
  happy: maruDecided,
};

/** Least space the transcript keeps free at its end; a speech bubble makes it taller. */
export const COMPANION_SPACE = DOG_SIZE;

/**
 * The dog that stays at the bottom right of the chat, reacts to the screen state and reads out the
 * reason of the card in view.
 */
export function ChatCompanion({
  phase,
  noCandidates,
  focus,
  onLayout,
}: {
  readonly phase: JourneyPhase;
  readonly noCandidates: boolean;
  readonly focus: CardSetFocus;
  readonly onLayout: (event: LayoutChangeEvent) => void;
}): React.JSX.Element {
  const subscribe = useCallback((listener: () => void) => focus.subscribe(listener), [focus]);
  const focused = useSyncExternalStore(subscribe, focus.current, focus.current);
  const speech = companionSpeech(focused);
  const { pose, bubble } = companionPose({ phase, noCandidates, speech: speech?.text ?? null });
  const meta = speech !== null && bubble === speech.text ? speech : null;
  const [hop] = useState(() => new Animated.Value(1));

  // Only a new pose makes the dog hop; swiping cards swaps the line in place without moving it.
  useEffect(() => {
    hop.setValue(0);
    const animation = Animated.spring(hop, {
      toValue: 1,
      friction: 5,
      tension: 160,
      useNativeDriver: NATIVE_DRIVER,
    });
    animation.start();
    return () => animation.stop();
  }, [hop, pose]);

  const motion = {
    opacity: hop.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1], extrapolate: 'clamp' }),
    transform: [
      { translateY: hop.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
      { scale: hop.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
    ],
  };

  return (
    <View onLayout={onLayout} pointerEvents="none" style={styles.anchor}>
      {bubble === null ? null : (
        // Only "nothing found" is announced; card reasons change on every swipe and stay readable.
        <Animated.View
          accessibilityLiveRegion={pose === 'notFound' ? 'polite' : 'none'}
          style={[styles.bubble, motion]}
        >
          {meta === null ? null : (
            <View style={styles.bubbleMeta}>
              {meta.position === null ? null : (
                <Text style={styles.bubblePosition}>{meta.position}</Text>
              )}
              <Text style={styles.bubbleRelation}>{meta.relation}</Text>
            </View>
          )}
          <Text style={styles.bubbleText}>{bubble}</Text>
          <View style={styles.bubbleTail} />
        </Animated.View>
      )}
      <Animated.Image
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        source={SOURCES[pose]}
        style={[styles.dog, motion]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    alignItems: 'flex-end',
    bottom: 0,
    flexDirection: 'row',
    gap: 2,
    justifyContent: 'flex-end',
    left: spacing.page,
    position: 'absolute',
    right: spacing.page,
  },
  bubble: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radii.small,
    borderWidth: 1,
    flexShrink: 1,
    marginBottom: DOG_SIZE / 2,
    paddingHorizontal: spacing.section,
    paddingVertical: spacing.compact,
  },
  bubbleMeta: {
    flexDirection: 'row',
    gap: spacing.compact,
    marginBottom: 2,
  },
  bubblePosition: {
    color: colors.lime,
    fontSize: typography.label,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  bubbleRelation: {
    color: colors.muted,
    fontSize: typography.label,
  },
  bubbleText: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '600',
    lineHeight: 20,
  },
  bubbleTail: {
    position: 'absolute',
    right: -6,
    bottom: 10,
    width: 10,
    height: 10,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRightWidth: 1,
    borderTopWidth: 1,
    transform: [{ rotate: '45deg' }],
  },
  dog: {
    height: DOG_SIZE,
    width: DOG_SIZE,
  },
});
