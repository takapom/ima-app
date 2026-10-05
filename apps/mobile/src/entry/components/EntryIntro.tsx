import { useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import maruBreath from '../../../assets/character/maru-breath.gif';
import { entryLayout, jumpArc } from '@mobile/entry/presentation/entry-motion';
import type { EntryRoute } from '@mobile/entry/state/entry-flow';
import { Icon } from '@mobile/ui/Icon';
import { ImaWordmark } from '@mobile/ui/ImaWordmark';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

const NATIVE_DRIVER = Platform.OS !== 'web';
const SPLASH_HOLD_MS = 900;
const WORDMARK_WIDTH = 168;
const JUMP_HEIGHT = 72;
const POSE = { rest: 0, crouch: 1, stretch: 2, air: 3, land: 4, settled: 5 } as const;
const POSE_INPUT = [0, 1, 2, 3, 4, 5];
const POSE_SCALE_X = [1, 1.1, 0.93, 1, 1.1, 1];
const POSE_SCALE_Y = [1, 0.84, 1.1, 1, 0.86, 1];

const CHOICES: readonly { route: EntryRoute; title: string; detail: string }[] = [
  { route: 'chat', title: 'チャットで話す', detail: 'いまの状況をそのまま書く' },
  { route: 'questions', title: '質問に答える', detail: 'タップで選んでいくだけ' },
];

type EntryIntroProps = {
  readonly interactive: boolean;
  readonly onSplashFinished: () => void;
  readonly onChoose: (route: EntryRoute) => void;
};

export function EntryIntro({
  interactive,
  onSplashFinished,
  onChoose,
}: EntryIntroProps): React.JSX.Element {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const layout = entryLayout({ width, height, bottomInset: insets.bottom });
  const [motion] = useState(() => ({
    wordmark: new Animated.Value(0),
    jump: new Animated.Value(0),
    pose: new Animated.Value(POSE.rest),
    pops: [new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)],
  }));

  useEffect(() => {
    const timing = (
      value: Animated.Value,
      toValue: number,
      duration: number,
      easing: (t: number) => number,
    ) => Animated.timing(value, { toValue, duration, easing, useNativeDriver: NATIVE_DRIVER });
    const intro = Animated.sequence([
      Animated.delay(SPLASH_HOLD_MS),
      Animated.parallel([
        timing(motion.wordmark, 1, 760, Easing.bezier(0.22, 1, 0.36, 1)),
        Animated.sequence([
          timing(motion.pose, POSE.crouch, 140, Easing.out(Easing.quad)),
          Animated.parallel([
            timing(motion.jump, 1, 560, Easing.linear),
            Animated.sequence([
              timing(motion.pose, POSE.stretch, 110, Easing.out(Easing.quad)),
              timing(motion.pose, POSE.air, 220, Easing.inOut(Easing.quad)),
            ]),
          ]),
          timing(motion.pose, POSE.land, 80, Easing.out(Easing.quad)),
          timing(motion.pose, POSE.settled, 240, Easing.out(Easing.back(2))),
        ]),
      ]),
    ]);
    const pop = Animated.stagger(
      90,
      motion.pops.map((value) =>
        Animated.spring(value, {
          toValue: 1,
          friction: 6,
          tension: 150,
          useNativeDriver: NATIVE_DRIVER,
        }),
      ),
    );
    let active = true;
    // Start the hold only after the splash has been painted; the chat mounting underneath
    // can block the first frames and would otherwise use up the hold before it is seen.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        intro.start(({ finished }) => {
          if (!finished || !active) return;
          onSplashFinished();
          pop.start();
        });
      });
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      intro.stop();
      pop.stop();
    };
  }, [motion, onSplashFinished]);

  const arc = jumpArc({
    dx: layout.dogEnd.x - layout.dogStart.x,
    dy: layout.dogEnd.y - layout.dogStart.y,
    height: JUMP_HEIGHT,
    steps: 12,
  });
  const pose = (outputRange: number[]) =>
    motion.pose.interpolate({ inputRange: POSE_INPUT, outputRange });
  const popIn = (value: Animated.Value) => ({
    opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
    transform: [
      { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }) },
      { scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) },
    ],
  });
  const wordmarkHeight = (WORDMARK_WIDTH * 222) / 350;
  const [bubble, ...choiceMotion] = motion.pops;

  return (
    <View style={styles.screen}>
      <Animated.View
        style={[
          styles.wordmark,
          {
            left: (width - WORDMARK_WIDTH) / 2,
            top: (height - wordmarkHeight) / 2,
            transform: [
              {
                translateY: motion.wordmark.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, layout.wordmarkShift],
                }),
              },
              { scale: motion.wordmark.interpolate({ inputRange: [0, 1], outputRange: [1, 0.8] }) },
            ],
          },
        ]}
      >
        <ImaWordmark width={WORDMARK_WIDTH} />
      </Animated.View>

      {bubble === undefined ? null : (
        <Animated.View
          accessibilityElementsHidden={!interactive}
          importantForAccessibility={interactive ? 'auto' : 'no-hide-descendants'}
          style={[
            styles.bubble,
            {
              left: layout.sidePadding,
              right: layout.sidePadding + layout.dogSize + 10,
              bottom: height - (layout.dogEnd.y + layout.dogSize - 12),
            },
            popIn(bubble),
          ]}
        >
          <Text style={styles.bubbleText}>
            チャットから始める？{'\n'}それとも質問に答えてみる？
          </Text>
          <View style={styles.bubbleTail} />
        </Animated.View>
      )}

      <Animated.View
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[
          styles.dog,
          {
            left: layout.dogStart.x,
            top: layout.dogStart.y,
            width: layout.dogSize,
            height: layout.dogSize,
            transform: [
              {
                translateX: motion.jump.interpolate({ inputRange: arc.input, outputRange: arc.x }),
              },
              {
                translateY: motion.jump.interpolate({ inputRange: arc.input, outputRange: arc.y }),
              },
              { translateY: pose(POSE_SCALE_Y.map((s) => (layout.dogSize * (1 - s)) / 2)) },
              { scaleX: pose(POSE_SCALE_X) },
              { scaleY: pose(POSE_SCALE_Y) },
            ],
          },
        ]}
      >
        <Image source={maruBreath} style={styles.dogImage} />
      </Animated.View>

      <View
        pointerEvents={interactive ? 'box-none' : 'none'}
        accessibilityElementsHidden={!interactive}
        importantForAccessibility={interactive ? 'auto' : 'no-hide-descendants'}
        style={[
          styles.choices,
          { left: layout.sidePadding, right: layout.sidePadding, top: layout.choicesTop },
          { gap: layout.choiceGap },
        ]}
      >
        {CHOICES.map((choice, index) => {
          const value = choiceMotion[index];
          return value === undefined ? null : (
            <Animated.View key={choice.route} style={popIn(value)}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${choice.title}。${choice.detail}`}
                onPress={() => onChoose(choice.route)}
                style={({ pressed }) => [
                  styles.choice,
                  { height: layout.choiceHeight },
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.choiceText}>
                  <Text style={styles.choiceTitle}>{choice.title}</Text>
                  <Text style={styles.choiceDetail}>{choice.detail}</Text>
                </View>
                <Icon name="chevron" color={colors.lime} />
              </Pressable>
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  wordmark: {
    position: 'absolute',
  },
  dog: {
    position: 'absolute',
  },
  dogImage: {
    width: '100%',
    height: '100%',
  },
  bubble: {
    position: 'absolute',
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radii.small,
    borderWidth: 1,
    paddingHorizontal: spacing.section,
    paddingVertical: spacing.section,
  },
  bubbleText: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '600',
    lineHeight: 21,
  },
  bubbleTail: {
    position: 'absolute',
    right: -6,
    bottom: 16,
    width: 12,
    height: 12,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRightWidth: 1,
    borderTopWidth: 1,
    transform: [{ rotate: '45deg' }],
  },
  choices: {
    position: 'absolute',
  },
  choice: {
    alignItems: 'center',
    backgroundColor: '#101010',
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    paddingHorizontal: spacing.section + 4,
  },
  choiceText: {
    flex: 1,
    gap: 2,
  },
  choiceTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  choiceDetail: {
    color: colors.muted,
    fontSize: typography.label,
  },
  pressed: {
    backgroundColor: colors.surface,
  },
});
