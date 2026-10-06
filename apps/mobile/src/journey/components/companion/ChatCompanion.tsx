import { useEffect, useState } from 'react';
import { Animated, Platform, StyleSheet, Text, View } from 'react-native';
import maruBreath from '../../../../assets/character/maru-breath.gif';
import maruDecided from '../../../../assets/character/maru-decided.png';
import maruEmpty from '../../../../assets/character/maru-empty.png';
import maruOops from '../../../../assets/character/maru-oops.png';
import maruRun from '../../../../assets/character/maru-run.gif';
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

/** Space the transcript keeps free at its end so the last content can scroll above the dog. */
export const COMPANION_SPACE = DOG_SIZE;

/** The dog that stays at the bottom right of the chat and reacts to the screen state. */
export function ChatCompanion({
  phase,
  noCandidates,
}: {
  readonly phase: JourneyPhase;
  readonly noCandidates: boolean;
}): React.JSX.Element {
  const { pose, bubble } = companionPose({ phase, noCandidates });
  const [hop] = useState(() => new Animated.Value(1));

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
    <View pointerEvents="none" style={styles.anchor}>
      {bubble === null ? null : (
        <Animated.View accessibilityLiveRegion="polite" style={[styles.bubble, motion]}>
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
    position: 'absolute',
    right: spacing.page,
  },
  bubble: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radii.small,
    borderWidth: 1,
    marginBottom: DOG_SIZE / 2,
    paddingHorizontal: spacing.section,
    paddingVertical: spacing.compact,
  },
  bubbleText: {
    color: colors.text,
    fontSize: typography.label,
    fontWeight: '700',
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
