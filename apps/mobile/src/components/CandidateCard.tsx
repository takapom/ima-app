import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { PublicCard } from '@ima/contracts';
import { colors, radii, scaleForDynamicType, spacing, typography } from '../theme/tokens';

type CandidateCardProps = {
  readonly card: PublicCard;
  readonly primary: boolean;
  readonly onChoose?: (candidateId: string) => void;
  readonly onDecide?: (candidateId: string) => void;
};

const cardIdentity = (card: PublicCard) =>
  card.facts.identity.status === 'known' ? card.facts.identity.value : null;

const walkingMinutes = (card: PublicCard): string => {
  const fact = card.facts.walking_route;
  if (fact?.status !== 'known') return '徒歩情報なし';
  return `徒歩${Math.max(1, Math.round(fact.value.durationSeconds / 60))}分`;
};

const photoLabel = (card: PublicCard): string => {
  const fact = card.facts.photos;
  if (fact === undefined) return '写真情報なし';
  if (fact.status === 'error') return '写真を表示できません';
  if (fact.status !== 'known') return '写真は未確認';
  const count = fact.value.photos.length;
  return count > 0 ? `写真 ${count}枚` : '写真なし';
};

const metaLabel = (card: PublicCard): string => {
  const identity = cardIdentity(card);
  const values = [identity?.area ?? '', identity?.category ?? '', walkingMinutes(card)].filter(
    (value) => value !== '徒歩情報なし' && value.length > 0,
  );
  return values.join(' · ');
};

export function CandidateCard({
  card,
  primary,
  onChoose,
  onDecide,
}: CandidateCardProps): React.JSX.Element {
  const { fontScale } = useWindowDimensions();
  const identity = cardIdentity(card);
  const name = identity?.name ?? '候補';
  const choose = (): void => onChoose?.(card.candidateId);
  const decide = (): void => onDecide?.(card.candidateId);

  if (!primary) {
    return (
      <Pressable
        accessibilityLabel={`${name}を主提案にする`}
        accessibilityRole="button"
        disabled={onChoose === undefined}
        onPress={choose}
        style={({ pressed }) => [styles.alternative, pressed && styles.pressed]}
      >
        <View
          style={[
            styles.thumbnail,
            {
              minHeight: scaleForDynamicType(56, fontScale),
              minWidth: scaleForDynamicType(56, fontScale),
            },
          ]}
        >
          <Text style={styles.thumbnailText}>{photoLabel(card)}</Text>
        </View>
        <View style={styles.alternativeBody}>
          <Text numberOfLines={1} style={styles.name}>
            {name}
          </Text>
          {card.diff ? <Text style={styles.diff}>{card.diff.text}</Text> : null}
        </View>
        <Text style={styles.walk}>{walkingMinutes(card)}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.hero}>
      <View style={[styles.heroVisual, { minHeight: scaleForDynamicType(168, fontScale) }]}>
        <Text style={styles.heroPhoto}>{photoLabel(card)}</Text>
        <View style={styles.heroOverlay}>
          <Text numberOfLines={1} style={styles.heroName}>
            {name}
          </Text>
          <Text style={styles.heroWalk}>{walkingMinutes(card)}</Text>
        </View>
      </View>
      <View style={styles.heroBody}>
        <Text numberOfLines={3} style={styles.why}>
          {card.why.text}
        </Text>
        <Text style={styles.meta}>{metaLabel(card)}</Text>
        <Pressable
          accessibilityLabel={`${name}に決める`}
          accessibilityRole="button"
          disabled={onDecide === undefined}
          onPress={decide}
          style={({ pressed }) => [styles.decide, pressed && styles.pressed]}
        >
          <Text style={styles.decideText}>ここにする</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    backgroundColor: colors.surface,
    borderColor: '#232323',
    borderRadius: 26,
    borderWidth: 1,
    overflow: 'hidden',
  },
  heroVisual: {
    backgroundColor: '#222224',
    justifyContent: 'flex-end',
    padding: spacing.section,
  },
  heroPhoto: {
    color: colors.muted,
    fontSize: typography.label,
    position: 'absolute',
    right: spacing.section,
    top: spacing.section,
  },
  heroOverlay: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  heroName: {
    color: colors.text,
    flex: 1,
    fontSize: typography.title,
    fontWeight: '800',
  },
  heroWalk: {
    color: colors.cream,
    fontSize: 20,
    fontWeight: '800',
    marginLeft: spacing.compact,
  },
  heroBody: {
    padding: spacing.section,
  },
  why: {
    color: '#cfcfc8',
    fontSize: 13,
    lineHeight: 20,
  },
  meta: {
    color: colors.muted,
    fontSize: typography.label,
    marginTop: spacing.compact,
    minHeight: 18,
  },
  decide: {
    alignItems: 'center',
    backgroundColor: colors.cream,
    borderRadius: radii.button,
    justifyContent: 'center',
    marginTop: spacing.section,
    minHeight: spacing.touch,
  },
  decideText: {
    color: colors.ink,
    fontSize: typography.button,
    fontWeight: '700',
  },
  alternative: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: '#232323',
    borderRadius: radii.button,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.compact,
    minHeight: 72,
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  thumbnail: {
    alignItems: 'center',
    backgroundColor: '#222224',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 56,
    minWidth: 56,
    padding: 4,
  },
  thumbnailText: {
    color: colors.faint,
    fontSize: 9,
    textAlign: 'center',
  },
  alternativeBody: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  name: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '800',
  },
  diff: {
    color: colors.lime,
    fontSize: typography.label,
  },
  walk: {
    color: colors.cream,
    fontSize: typography.label,
    fontWeight: '800',
    maxWidth: 76,
    textAlign: 'right',
  },
  pressed: {
    opacity: 0.72,
  },
});
