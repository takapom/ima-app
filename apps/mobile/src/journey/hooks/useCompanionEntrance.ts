import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, type View } from 'react-native';
import { companionEntrance, type CompanionPose } from '@mobile/journey/state/companion-pose';
import type { RunnerHandoff, RunnerSpot } from '@mobile/journey/state/runner-handoff';
import { JUMP_SQUASH, jumpArc } from '@mobile/ui/presentation/jump-arc';

const NATIVE_DRIVER = Platform.OS !== 'web';
const ARC_HEIGHT = 60;
const ARC_STEPS = 12;
const POSE = { rest: 0, crouch: 1, stretch: 2, air: 3, land: 4, settled: 5 } as const;
const POSE_INPUT = [0, 1, 2, 3, 4, 5];
const POSE_SCALE_X = [1, JUMP_SQUASH.crouch.x, JUMP_SQUASH.stretch.x, 1, JUMP_SQUASH.land.x, 1];
const POSE_SCALE_Y = [1, JUMP_SQUASH.crouch.y, JUMP_SQUASH.stretch.y, 1, JUMP_SQUASH.land.y, 1];

type Flight = { readonly input: number[]; readonly x: number[]; readonly y: number[] };

/** The offsets that carry the dog from the runner's paws to its own, ending at zero. */
const flightFrom = (runner: RunnerSpot, corner: RunnerSpot): Flight => {
  const startX = runner.x + runner.size / 2 - (corner.x + corner.size / 2);
  const startY = runner.y + runner.size - (corner.y + corner.size);
  const arc = jumpArc({ dx: -startX, dy: -startY, height: ARC_HEIGHT, steps: ARC_STEPS });
  return {
    input: arc.input,
    x: arc.x.map((value) => value + startX),
    y: arc.y.map((value) => value + startY),
  };
};

/**
 * How the corner dog enters: a hop in place for a new pose, or, when a search ends, a jump from
 * where the runner stood in the conversation. The bubble appears once the dog has landed.
 */
export function useCompanionEntrance({
  pose,
  handoff,
  reduceMotion,
  dogSize,
}: {
  readonly pose: CompanionPose;
  readonly handoff: RunnerHandoff;
  readonly reduceMotion: boolean | null;
  readonly dogSize: number;
}) {
  const dogRef = useRef<View>(null);
  const previous = useRef(pose);
  const [values] = useState(() => ({
    shown: new Animated.Value(pose === 'away' ? 0 : 1),
    dogHop: new Animated.Value(1),
    bubbleHop: new Animated.Value(1),
    travel: new Animated.Value(1),
    squash: new Animated.Value(POSE.settled),
  }));
  const [flight, setFlight] = useState<Flight | null>(null);

  useEffect(() => {
    const entrance = companionEntrance(previous.current, pose);
    previous.current = pose;
    const { shown, dogHop, bubbleHop } = values;
    if (pose === 'away') {
      shown.setValue(0);
      return undefined;
    }
    if (entrance === 'none') return undefined;
    const runner = entrance === 'jumpIn' ? handoff.last() : null;
    const corner = dogRef.current;
    if (entrance === 'jumpIn' && runner !== null && corner !== null && reduceMotion === false) {
      bubbleHop.setValue(0);
      corner.measureInWindow((x, y, width) => {
        if (Number.isFinite(x) && Number.isFinite(y)) {
          setFlight(flightFrom(runner, { x, y, size: width > 0 ? width : dogSize }));
          return;
        }
        shown.setValue(1);
        bubbleHop.setValue(1);
      });
      return undefined;
    }
    shown.setValue(1);
    if (entrance === 'jumpIn') {
      bubbleHop.setValue(1);
      return undefined;
    }
    dogHop.setValue(0);
    bubbleHop.setValue(0);
    const spring = (value: Animated.Value) =>
      Animated.spring(value, {
        toValue: 1,
        friction: 5,
        tension: 160,
        useNativeDriver: NATIVE_DRIVER,
      });
    const animation = Animated.parallel([spring(dogHop), spring(bubbleHop)]);
    animation.start();
    return () => animation.stop();
  }, [dogSize, handoff, pose, reduceMotion, values]);

  useEffect(() => {
    if (flight === null) return undefined;
    const { shown, travel, squash, bubbleHop } = values;
    const timing = (
      value: Animated.Value,
      toValue: number,
      duration: number,
      easing = Easing.out(Easing.quad),
    ) => Animated.timing(value, { toValue, duration, easing, useNativeDriver: NATIVE_DRIVER });
    travel.setValue(0);
    squash.setValue(POSE.rest);
    shown.setValue(1);
    const animation = Animated.sequence([
      timing(squash, POSE.crouch, 140),
      Animated.parallel([
        timing(travel, 1, 640, Easing.linear),
        Animated.sequence([
          timing(squash, POSE.stretch, 110),
          timing(squash, POSE.air, 220, Easing.inOut(Easing.quad)),
        ]),
      ]),
      timing(squash, POSE.land, 80),
      timing(squash, POSE.settled, 240, Easing.out(Easing.back(2))),
      Animated.spring(bubbleHop, {
        toValue: 1,
        friction: 5,
        tension: 160,
        useNativeDriver: NATIVE_DRIVER,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [flight, values]);

  const { shown, dogHop, bubbleHop, travel, squash } = values;
  const squashed = (outputRange: number[]) =>
    squash.interpolate({ inputRange: POSE_INPUT, outputRange });
  return {
    dogRef,
    dogStyle: {
      opacity: Animated.multiply(
        shown,
        dogHop.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1], extrapolate: 'clamp' }),
      ),
      transform: [
        {
          translateX:
            flight === null
              ? 0
              : travel.interpolate({ inputRange: flight.input, outputRange: flight.x }),
        },
        {
          translateY:
            flight === null
              ? 0
              : travel.interpolate({ inputRange: flight.input, outputRange: flight.y }),
        },
        { translateY: dogHop.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
        { translateY: squashed(POSE_SCALE_Y.map((scale) => (dogSize * (1 - scale)) / 2)) },
        { scaleX: squashed(POSE_SCALE_X) },
        { scaleY: squashed(POSE_SCALE_Y) },
        { scale: dogHop.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
      ],
    },
    bubbleStyle: {
      opacity: bubbleHop.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
      transform: [
        { translateY: bubbleHop.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
        { scale: bubbleHop.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
      ],
    },
  };
}
