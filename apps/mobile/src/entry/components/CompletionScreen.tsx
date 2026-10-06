import { useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Platform,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import maruRun from '../../../assets/character/maru-run.gif';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

const NATIVE_DRIVER = Platform.OS !== 'web';
const MARK = 132;
const RING_RADIUS = 56;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
/** A full circle that starts at the top and runs clockwise, so drawing it needs no rotation. */
const RING_PATH = `M${MARK / 2} ${MARK / 2 - RING_RADIUS} a${RING_RADIUS} ${RING_RADIUS} 0 1 1 0 ${RING_RADIUS * 2} a${RING_RADIUS} ${RING_RADIUS} 0 1 1 0 ${-RING_RADIUS * 2}`;
const CHECK_LENGTH = 72;
const DOG_SIZE = 104;
const HOLD_MS = 1000;

type CompletionScreenProps = {
  /** The message being sent, shown so the answers can be read back. */
  readonly query: string;
  readonly onDone: () => void;
};

/** SVG props are drawn from plain numbers; animated SVG components add invalid attributes on web. */
function useAnimatedNumber(value: Animated.Value): number {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const id = value.addListener(({ value: next }) => setCurrent(next));
    return () => value.removeListener(id);
  }, [value]);
  return current;
}

/** Draws a check mark, lets the dog announce the search, and hands over to the chat. */
export function CompletionScreen({ query, onDone }: CompletionScreenProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [motion] = useState(() => ({
    ring: new Animated.Value(0),
    check: new Animated.Value(0),
    pop: new Animated.Value(0),
    leave: new Animated.Value(0),
  }));
  const ring = useAnimatedNumber(motion.ring);
  const check = useAnimatedNumber(motion.check);

  useEffect(() => {
    const draw = (value: Animated.Value, duration: number) =>
      Animated.timing(value, {
        toValue: 1,
        duration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      });
    const sequence = Animated.sequence([
      draw(motion.ring, 480),
      draw(motion.check, 280),
      Animated.spring(motion.pop, {
        toValue: 1,
        friction: 6,
        tension: 150,
        restDisplacementThreshold: 0.02,
        restSpeedThreshold: 0.05,
        useNativeDriver: NATIVE_DRIVER,
      }),
      Animated.delay(HOLD_MS),
      Animated.timing(motion.leave, {
        toValue: 1,
        duration: 420,
        easing: Easing.in(Easing.quad),
        useNativeDriver: NATIVE_DRIVER,
      }),
    ]);
    sequence.start(({ finished }) => {
      if (finished) onDone();
    });
    return () => sequence.stop();
  }, [motion, onDone]);

  const popIn = {
    opacity: motion.pop.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    }),
    transform: [
      { translateY: motion.pop.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }) },
      { scale: motion.pop.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) },
    ],
  };

  return (
    <View
      accessible
      accessibilityLabel={`質問はここまで。${query}で探します。`}
      accessibilityLiveRegion="polite"
      style={[styles.screen, { paddingBottom: insets.bottom + spacing.canvas }]}
    >
      <View style={styles.center}>
        <Svg width={MARK} height={MARK} viewBox={`0 0 ${MARK} ${MARK}`}>
          <Circle
            cx={MARK / 2}
            cy={MARK / 2}
            r={RING_RADIUS}
            stroke={colors.border}
            strokeWidth={6}
            fill="none"
          />
          {ring > 0 ? (
            <Path
              d={RING_PATH}
              stroke={colors.lime}
              strokeWidth={6}
              strokeLinecap="round"
              fill="none"
              strokeDasharray={RING_LENGTH}
              strokeDashoffset={RING_LENGTH * (1 - ring)}
            />
          ) : null}
          {check > 0 ? (
            <Path
              d="M42 68 L59 85 L92 50"
              stroke={colors.lime}
              strokeWidth={9}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              strokeDasharray={CHECK_LENGTH}
              strokeDashoffset={CHECK_LENGTH * (1 - check)}
            />
          ) : null}
        </Svg>
        <Animated.Text style={[styles.query, { opacity: motion.check }]}>{query}</Animated.Text>
      </View>

      <Animated.View
        style={[
          styles.dogArea,
          popIn,
          {
            transform: [
              ...popIn.transform,
              {
                translateX: motion.leave.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, width],
                }),
              },
            ],
          },
        ]}
      >
        <View style={styles.bubble}>
          <Text style={styles.bubbleText}>探してくるわん！</Text>
          <View style={styles.bubbleTail} />
        </View>
        <Image source={maruRun} style={styles.dog} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.canvas,
  },
  center: {
    alignItems: 'center',
    flex: 1,
    gap: spacing.section * 2,
    justifyContent: 'center',
  },
  query: {
    color: colors.muted,
    fontSize: typography.body,
    lineHeight: 22,
    textAlign: 'center',
  },
  dogArea: {
    alignItems: 'flex-end',
    alignSelf: 'flex-end',
    gap: 4,
  },
  bubble: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radii.small,
    borderWidth: 1,
    marginRight: DOG_SIZE / 2,
    paddingHorizontal: spacing.section,
    paddingVertical: spacing.compact,
  },
  bubbleText: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
  },
  bubbleTail: {
    position: 'absolute',
    right: 14,
    bottom: -6,
    width: 12,
    height: 12,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderBottomWidth: 1,
    borderRightWidth: 1,
    transform: [{ rotate: '45deg' }],
  },
  dog: {
    height: DOG_SIZE,
    width: DOG_SIZE,
  },
});
