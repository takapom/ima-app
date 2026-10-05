import { useEffect, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';
import type { ProgressSegment } from '@mobile/entry/presentation/entry-questions';
import { colors, typography } from '@mobile/ui/theme/tokens';

const NATIVE_DRIVER = Platform.OS !== 'web';

/** One segment per question: answered ones fill in lime from the left, the next one is outlined. */
export function QuestionProgress({
  segments,
}: {
  readonly segments: readonly ProgressSegment[];
}): React.JSX.Element {
  const [fills] = useState(() =>
    segments.map((segment) => new Animated.Value(segment === 'done' ? 1 : 0)),
  );
  const done = segments.filter((segment) => segment === 'done').length;
  const current = Math.min(done + 1, segments.length);

  useEffect(() => {
    const animations = segments.map((segment, index) => {
      const fill = fills[index];
      return fill === undefined
        ? null
        : Animated.timing(fill, {
            toValue: segment === 'done' ? 1 : 0,
            duration: 320,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: NATIVE_DRIVER,
          });
    });
    const running = Animated.parallel(animations.filter((animation) => animation !== null));
    running.start();
    return () => running.stop();
  }, [fills, segments]);

  return (
    <View accessible accessibilityLabel={`${segments.length}問中${current}問目`} style={styles.row}>
      <View style={styles.segments}>
        {segments.map((segment, index) => {
          const fill = fills[index];
          return (
            <View
              key={index}
              style={[styles.segment, segment === 'current' && styles.segmentCurrent]}
            >
              {fill === undefined ? null : (
                <Animated.View style={[styles.fill, { transform: [{ scaleX: fill }] }]} />
              )}
            </View>
          );
        })}
      </View>
      <Text style={styles.count}>
        {current}
        <Text style={styles.total}> / {segments.length}</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  segments: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
  },
  segment: {
    borderColor: colors.border,
    borderRadius: 4,
    borderWidth: 1,
    flex: 1,
    height: 10,
    overflow: 'hidden',
  },
  segmentCurrent: {
    borderColor: colors.lime,
  },
  fill: {
    backgroundColor: colors.lime,
    height: '100%',
    transformOrigin: 'left',
    width: '100%',
  },
  count: {
    color: colors.text,
    fontSize: typography.label,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    minWidth: 36,
    textAlign: 'right',
  },
  total: {
    color: colors.muted,
    fontWeight: '500',
  },
});
