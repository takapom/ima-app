import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Image, Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import maruRun from '../../../../assets/character/maru-run.gif';
import maruSearch from '../../../../assets/character/maru-search.png';
import {
  RUNNER_PIXEL,
  RUNNER_STAGE,
  runnerCycle,
  runnerFoodAt,
  workingRunnerMotion,
  type RunnerFood,
  type RunnerKeyframes,
} from '@mobile/journey/components/response/working-runner-model';
import { useReduceMotion } from '@mobile/journey/hooks/useReduceMotion';
import type { RunnerHandoff } from '@mobile/journey/state/runner-handoff';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

type WorkingStateProps = {
  readonly query: string;
  readonly handoff?: RunnerHandoff;
};

const NATIVE_DRIVER = Platform.OS !== 'web';
const DASH = 12;
const DASH_GAP = 8;
const DASH_PERIOD = DASH + DASH_GAP;

export function WorkingState({ query, handoff }: WorkingStateProps): React.JSX.Element {
  const motion = workingRunnerMotion(useReduceMotion());
  return (
    <View style={styles.container}>
      {query.length > 0 ? <Text style={styles.bubble}>{query}</Text> : null}
      <View accessibilityLiveRegion="polite" style={styles.status}>
        <View style={styles.statusDot} />
        <View style={styles.statusBody}>
          <Text style={styles.title}>いま探しています</Text>
          <Text style={styles.detail}>近くで今いける場所を確認しています。</Text>
        </View>
      </View>
      <Runner running={motion === 'run'} {...(handoff === undefined ? {} : { handoff })} />
    </View>
  );
}

/** The dog keeps running and clears one food after another; nothing here is read aloud. */
function Runner({
  running,
  handoff,
}: {
  readonly running: boolean;
  readonly handoff?: RunnerHandoff;
}): React.JSX.Element {
  const dogRef = useRef<View>(null);
  const [width, setWidth] = useState(0);
  const [lap, setLap] = useState(0);
  const [clock] = useState(() => new Animated.Value(0));
  const [ground] = useState(() => new Animated.Value(0));
  const cycle = useMemo(() => runnerCycle(width), [width]);
  const animate = running && width > 0;

  useEffect(() => {
    handoff?.report(null);
  }, [handoff]);

  useEffect(() => {
    dogRef.current?.measureInWindow((x, y, size) => {
      if (Number.isFinite(x) && Number.isFinite(y)) handoff?.report({ x, y, size });
    });
    if (!animate) return undefined;
    clock.setValue(0);
    const animation = Animated.timing(clock, {
      toValue: 1,
      duration: cycle.durationMs,
      easing: Easing.linear,
      useNativeDriver: NATIVE_DRIVER,
    });
    animation.start(({ finished }) => {
      if (finished) setLap((count) => count + 1);
    });
    return () => animation.stop();
  }, [animate, clock, cycle, handoff, lap]);

  useEffect(() => {
    if (!animate) return undefined;
    ground.setValue(0);
    const loop = Animated.loop(
      Animated.timing(ground, {
        toValue: 1,
        duration: (DASH_PERIOD / RUNNER_STAGE.speed) * 1000,
        easing: Easing.linear,
        useNativeDriver: NATIVE_DRIVER,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [animate, ground]);

  const along = (frames: RunnerKeyframes) =>
    clock.interpolate({ inputRange: [...frames.input], outputRange: [...frames.output] });
  const dashes = Math.ceil(width / DASH_PERIOD) + 2;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
      style={styles.stage}
    >
      <Animated.View
        style={[
          styles.ground,
          {
            width: dashes * DASH_PERIOD,
            transform: [
              {
                translateX: ground.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, -DASH_PERIOD],
                }),
              },
            ],
          },
        ]}
      >
        {Array.from({ length: dashes }, (_, index) => (
          <View key={index} style={styles.dash} />
        ))}
      </Animated.View>
      {animate ? (
        <Animated.View
          style={[styles.food, { transform: [{ translateX: along(cycle.obstacleX) }] }]}
        >
          <FoodSprite food={runnerFoodAt(lap)} />
        </Animated.View>
      ) : null}
      <View collapsable={false} ref={dogRef} style={styles.dog}>
        {animate ? (
          <Animated.Image
            source={maruRun}
            style={[
              styles.dogImage,
              {
                transform: [
                  { translateY: along(cycle.dogTranslateY) },
                  { scaleX: along(cycle.dogScaleX) },
                  { scaleY: along(cycle.dogScaleY) },
                ],
              },
            ]}
          />
        ) : (
          <Image source={maruSearch} style={styles.dogImage} />
        )}
      </View>
    </View>
  );
}

function FoodSprite({ food }: { readonly food: RunnerFood }): React.JSX.Element {
  const columns = food.rows[0]?.length ?? 0;
  return (
    <Svg height={food.rows.length * RUNNER_PIXEL} width={columns * RUNNER_PIXEL}>
      {food.rows.flatMap((row, y) =>
        [...row].flatMap((cell, x) => {
          const fill = food.palette[cell];
          return fill === undefined
            ? []
            : [
                <Rect
                  key={`${x}:${y}`}
                  fill={fill}
                  height={RUNNER_PIXEL}
                  width={RUNNER_PIXEL}
                  x={x * RUNNER_PIXEL}
                  y={y * RUNNER_PIXEL}
                />,
              ];
        }),
      )}
    </Svg>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 14,
    paddingHorizontal: spacing.page,
    paddingTop: 10,
  },
  bubble: {
    alignSelf: 'flex-end',
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radii.card,
    color: colors.text,
    fontSize: 13,
    lineHeight: 21,
    maxWidth: '86%',
    paddingHorizontal: spacing.section,
    paddingVertical: 11,
  },
  status: {
    flexDirection: 'row',
    gap: 9,
    paddingHorizontal: 4,
  },
  statusDot: {
    backgroundColor: colors.lime,
    borderRadius: 3,
    height: 6,
    marginTop: 7,
    width: 6,
  },
  statusBody: { flex: 1 },
  title: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
  },
  detail: {
    color: colors.muted,
    fontSize: typography.label,
    marginTop: 2,
  },
  stage: {
    height: RUNNER_STAGE.height,
    marginHorizontal: -spacing.page,
    overflow: 'hidden',
  },
  ground: {
    bottom: RUNNER_STAGE.groundBottom - 2,
    flexDirection: 'row',
    gap: DASH_GAP,
    left: 0,
    position: 'absolute',
  },
  dash: { backgroundColor: colors.faint, height: 2, width: DASH },
  food: {
    bottom: RUNNER_STAGE.groundBottom,
    left: 0,
    position: 'absolute',
  },
  dog: {
    bottom: RUNNER_STAGE.dogBottom,
    height: RUNNER_STAGE.dogSize,
    left: RUNNER_STAGE.dogLeft,
    position: 'absolute',
    width: RUNNER_STAGE.dogSize,
  },
  dogImage: {
    height: RUNNER_STAGE.dogSize,
    width: RUNNER_STAGE.dogSize,
  },
});
