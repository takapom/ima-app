import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { PublicCard } from '@ima/contracts';
import type { JourneyPhotoClient } from '../../services/api/photo-client';
import { collectAttributions } from '../../presentation/attribution';
import type { AttributionPresentation } from '../../presentation/attribution';
import {
  collectPhotoAttributions,
  presentCardFacts,
  presentEvidenceText,
  presentFact,
  type FactPresentation,
} from './candidate-card-model';
import { PhotoRegion } from './PhotoRegion';
import { colors, radii, scaleForDynamicType, spacing, typography } from '../../theme/tokens';

type CandidateCardProps = {
  readonly card: PublicCard;
  readonly primary: boolean;
  readonly onChoose?: (candidateId: string) => void;
  readonly onDecide?: (candidateId: string) => void;
  readonly onSave?: (card: PublicCard) => void;
  readonly onSkip?: (candidateId: string) => void;
  readonly onSourcePress?: (sourceLink: string) => void;
  readonly photoClient?: JourneyPhotoClient;
};

const cardIdentity = (card: PublicCard) => {
  const field = card.facts.identity;
  return field.status === 'known' && presentFact(field, (value) => value.name).status === 'known'
    ? field.value
    : null;
};

const walkingMinutes = (card: PublicCard): string => {
  const fact = card.facts.walking_route;
  if (
    fact?.status !== 'known' ||
    presentFact(fact, (value) => String(value.durationSeconds)).status !== 'known'
  ) {
    return '徒歩情報なし';
  }
  return `徒歩${Math.max(1, Math.round(fact.value.durationSeconds / 60))}分`;
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
  onSave,
  onSkip,
  onSourcePress,
  photoClient,
}: CandidateCardProps): React.JSX.Element {
  const { fontScale } = useWindowDimensions();
  const identity = cardIdentity(card);
  const name = identity?.name ?? '候補';
  const facts = presentCardFacts(card);
  const why = presentEvidenceText(card.why);
  const diff = card.diff === undefined ? null : presentEvidenceText(card.diff);
  const identityEvidence = presentFact(card.facts.identity, (value) => value.name).evidence;
  const walkingEvidence = presentFact(card.facts.walking_route, (value) =>
    String(value.durationSeconds),
  ).evidence;
  const attributions = [
    ...collectAttributions([
      identityEvidence,
      walkingEvidence,
      facts.openingHours.evidence,
      facts.price.evidence,
      facts.lastTrain.evidence,
      why.evidence,
      ...(diff === null ? [] : [diff.evidence]),
    ]),
    ...collectPhotoAttributions(card),
  ];
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
          <PhotoRegion
            card={card}
            compact
            {...(photoClient === undefined ? {} : { client: photoClient })}
          />
        </View>
        <View style={styles.alternativeBody}>
          <Text numberOfLines={1} style={styles.name}>
            {name}
          </Text>
          {diff ? <Text style={styles.diff}>{diff.text}</Text> : null}
          <Text numberOfLines={2} style={styles.factSummary}>
            {[facts.openingHours.label, facts.price.label, facts.lastTrain.label].join(' · ')}
          </Text>
          <AttributionList
            attributions={attributions}
            {...(onSourcePress === undefined ? {} : { onSourcePress })}
          />
        </View>
        <Text style={styles.walk}>{walkingMinutes(card)}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.hero}>
      <View style={[styles.heroVisual, { minHeight: scaleForDynamicType(168, fontScale) }]}>
        <PhotoRegion card={card} {...(photoClient === undefined ? {} : { client: photoClient })} />
        <View style={styles.heroOverlay}>
          <Text numberOfLines={1} style={styles.heroName}>
            {name}
          </Text>
          <Text style={styles.heroWalk}>{walkingMinutes(card)}</Text>
        </View>
      </View>
      <View style={styles.heroBody}>
        <Text numberOfLines={3} style={styles.why}>
          {why.text}
        </Text>
        {diff ? <Text style={styles.diff}>{diff.text}</Text> : null}
        <Text style={styles.meta}>{metaLabel(card)}</Text>
        <View style={styles.factList}>
          <FactRow label="営業" fact={facts.openingHours} />
          <FactRow label="価格" fact={facts.price} />
          <FactRow label="終電" fact={facts.lastTrain} />
        </View>
        <AttributionList
          attributions={attributions}
          {...(onSourcePress === undefined ? {} : { onSourcePress })}
        />
        <Pressable
          accessibilityLabel={`${name}に決める`}
          accessibilityRole="button"
          disabled={onDecide === undefined}
          onPress={decide}
          style={({ pressed }) => [styles.decide, pressed && styles.pressed]}
        >
          <Text style={styles.decideText}>ここにする</Text>
        </Pressable>
        <View style={styles.actionRow}>
          <Pressable
            accessibilityLabel={`${name}を残す`}
            accessibilityRole="button"
            disabled={onSave === undefined}
            onPress={() => onSave?.(card)}
            style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryActionText}>残す</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={`${name}を今夜の候補から外す`}
            accessibilityRole="button"
            disabled={onSkip === undefined}
            onPress={() => onSkip?.(card.candidateId)}
            style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryActionText}>ちがう</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

type FactRowProps = {
  readonly label: string;
  readonly fact: FactPresentation;
};

function FactRow({ label, fact }: FactRowProps): React.JSX.Element {
  return (
    <View style={styles.factRow}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, fact.status === 'known' ? null : styles.factUnavailable]}>
        {fact.label}
      </Text>
    </View>
  );
}

export type AttributionListProps = {
  readonly attributions: readonly AttributionPresentation[];
  readonly onSourcePress?: (sourceLink: string) => void;
};

export function AttributionList({
  attributions,
  onSourcePress,
}: AttributionListProps): React.JSX.Element | null {
  if (attributions.length === 0) return null;
  return (
    <View style={styles.attribution}>
      <Text style={styles.attributionLabel}>出典</Text>
      {attributions.map((attribution) => {
        if (attribution.sourceLink !== null && onSourcePress !== undefined) {
          const sourceLink = attribution.sourceLink;
          return (
            <Pressable
              accessibilityLabel={`${attribution.label}を開く`}
              accessibilityRole="link"
              key={`${attribution.label}:${sourceLink}`}
              onPress={() => onSourcePress(sourceLink)}
            >
              <Text style={styles.attributionLink}>{attribution.label}</Text>
            </Pressable>
          );
        }
        return (
          <Text
            key={`${attribution.label}:${attribution.sourceLink ?? ''}`}
            style={styles.attributionText}
          >
            {attribution.label}
          </Text>
        );
      })}
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
    position: 'relative',
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
  actionRow: {
    flexDirection: 'row',
    gap: spacing.compact,
    marginTop: spacing.compact,
  },
  secondaryAction: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.button,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: spacing.touch,
  },
  secondaryActionText: {
    color: colors.text,
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
  factSummary: {
    color: colors.muted,
    fontSize: typography.label,
    lineHeight: 17,
    marginTop: 3,
  },
  factList: {
    gap: 4,
    marginTop: spacing.section,
  },
  factRow: {
    flexDirection: 'row',
    gap: spacing.compact,
  },
  factLabel: {
    color: colors.faint,
    fontSize: typography.label,
    fontWeight: '700',
    minWidth: 36,
  },
  factValue: {
    color: colors.text,
    flex: 1,
    fontSize: typography.label,
    lineHeight: 18,
  },
  factUnavailable: {
    color: colors.muted,
  },
  attribution: {
    gap: 3,
    marginTop: spacing.section,
  },
  attributionLabel: {
    color: colors.faint,
    fontSize: typography.label,
    fontWeight: '700',
  },
  attributionText: {
    color: colors.muted,
    fontSize: typography.label,
  },
  attributionLink: {
    color: colors.lime,
    fontSize: typography.label,
    textDecorationLine: 'underline',
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
