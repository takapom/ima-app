import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Platform, StyleSheet, Text, View } from 'react-native';
import { styles as cardStyles } from '@mobile/journey/components/candidates/candidate-card-styles';
import {
  WORKING_SKELETON_CARDS,
  workingSkeletonMotion,
  type WorkingSkeletonCard,
} from '@mobile/journey/components/response/working-state-model';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

type WorkingStateProps = {
  readonly query: string;
};

const PULSE_MS = 900;
const PULSE_LOW_OPACITY = 0.45;
const USE_NATIVE_DRIVER = Platform.OS !== 'web';
const FACTS = ['access', 'opening', 'budget'] as const;

export function WorkingState({ query }: WorkingStateProps): React.JSX.Element {
  const opacity = useSkeletonPulse();
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
      <Animated.View aria-hidden style={[styles.cards, { opacity }]}>
        {WORKING_SKELETON_CARDS.map((card) => (
          <SkeletonCard key={card.key} card={card} />
        ))}
      </Animated.View>
    </View>
  );
}

function SkeletonCard({ card }: { readonly card: WorkingSkeletonCard }): React.JSX.Element {
  return (
    <View style={cardStyles.card}>
      <View style={cardStyles.summary}>
        <View style={[cardStyles.thumbnail, styles.block]} />
        <View style={cardStyles.heading}>
          <View style={[styles.line, styles.category]} />
          <View style={[styles.line, styles.name, { width: card.nameWidth }]} />
          {FACTS.map((fact, index) => (
            <View key={fact} style={styles.fact}>
              <View style={styles.factIcon} />
              <View style={[styles.line, { width: card.factWidths[index] }]} />
            </View>
          ))}
        </View>
        <View style={cardStyles.sideActions}>
          <View style={cardStyles.iconAction} />
          <View style={cardStyles.iconAction} />
        </View>
      </View>
      <View style={[cardStyles.detailsAction, styles.block]} />
    </View>
  );
}

const useReduceMotion = (): boolean | null => {
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (enabled) => {
        if (active) setReduceMotion(enabled);
      },
      () => undefined,
    );
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      if (active) setReduceMotion(enabled);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduceMotion;
};

const useSkeletonPulse = (): Animated.Value => {
  const [opacity] = useState(() => new Animated.Value(1));
  const motion = workingSkeletonMotion(useReduceMotion());
  useEffect(() => {
    if (motion === 'still') {
      opacity.setValue(1);
      return undefined;
    }
    const pulse = (toValue: number) =>
      Animated.timing(opacity, { toValue, duration: PULSE_MS, useNativeDriver: USE_NATIVE_DRIVER });
    const loop = Animated.loop(Animated.sequence([pulse(PULSE_LOW_OPACITY), pulse(1)]));
    loop.start();
    return () => loop.stop();
  }, [motion, opacity]);
  return opacity;
};

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
  cards: { gap: spacing.section },
  block: { backgroundColor: colors.surfaceRaised },
  line: {
    backgroundColor: colors.border,
    borderRadius: radii.pill,
    height: 10,
  },
  category: { width: '30%' },
  name: { height: 16, marginBottom: 2 },
  fact: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  factIcon: {
    backgroundColor: colors.border,
    borderRadius: 7,
    height: 14,
    width: 14,
  },
});
