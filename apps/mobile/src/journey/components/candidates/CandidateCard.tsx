import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PublicCard } from '@ima/contracts';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import { collectAttributions, dedupeAttributions } from '@mobile/ui/presentation/attribution';
import type { AttributionPresentation } from '@mobile/ui/presentation/attribution';
import {
  cardRenderNow,
  toCardViewModel,
  type CardOpening,
  type CardViewModel,
} from '@mobile/journey/presentation/candidate-card-view';
import {
  collectPhotoAttributions,
  presentFact,
} from '@mobile/journey/components/candidates/candidate-card-model';
import {
  AmenityChips,
  Chevron,
  HoursLine,
  MetaLine,
  PhotoScrim,
  StatusPill,
} from '@mobile/journey/components/candidates/CandidateCardParts';
import { PhotoRegion } from '@mobile/journey/components/candidates/PhotoRegion';
import { colors, spacing, typography } from '@mobile/ui/theme/tokens';

const ALT_THUMBNAIL = 76;

type CandidateCardProps = {
  readonly card: PublicCard;
  readonly primary: boolean;
  /** Injected render time; the countdown is resolved here, never baked in upstream. */
  readonly now?: string;
  readonly onChoose?: (candidateId: string) => void;
  readonly onDecide?: (candidateId: string) => void;
  readonly onSave?: (card: PublicCard) => void;
  readonly onSkip?: (candidateId: string) => void;
  readonly onSourcePress?: (sourceLink: string) => void;
  readonly photoClient?: JourneyPhotoClient;
};

/** Photo attribution repeats the provider the other fields already cite; key on unique sources. */
const cardAttributions = (card: PublicCard): readonly AttributionPresentation[] =>
  dedupeAttributions([
    ...collectAttributions([
      presentFact(card.facts.identity, (value) => value.name).evidence,
      presentFact(card.facts.opening_hours, () => '').evidence,
      presentFact(card.facts.price, () => '').evidence,
      presentFact(card.facts.facilities, () => '').evidence,
      presentFact(card.facts.walking_route, () => '').evidence,
    ]),
    ...collectPhotoAttributions(card),
  ]);

/** One-line opening summary for the quieter alternative rows. */
const openingSummary = (opening: CardOpening): string | null => {
  switch (opening.kind) {
    case 'none':
      return null;
    case 'listed':
      return opening.text;
    case 'closed':
      return opening.reopensAtLabel === null ? '本日は終了' : `${opening.reopensAtLabel}から`;
    case 'open':
    case 'closing':
      return `${opening.closesAtLabel}まで`;
  }
};

export function CandidateCard({
  card,
  primary,
  now,
  onChoose,
  onDecide,
  onSave,
  onSkip,
  onSourcePress,
  photoClient,
}: CandidateCardProps): React.JSX.Element {
  const view = toCardViewModel(card, cardRenderNow(now));
  const attributions = cardAttributions(card);

  if (!primary) {
    return (
      <AlternativeRow
        card={card}
        view={view}
        {...(onChoose === undefined ? {} : { onChoose })}
        {...(photoClient === undefined ? {} : { photoClient })}
      />
    );
  }

  const saveAction = onSave === undefined ? undefined : (): void => onSave(card);
  const decideAction = onDecide === undefined ? undefined : (): void => onDecide(card.candidateId);
  const primaryIsSave = view.primaryAction === 'save';

  const heading = (
    <>
      {view.category === null ? null : (
        <Text style={view.dimmed ? styles.categoryDim : styles.category}>{view.category}</Text>
      )}
      <Text style={view.dimmed ? styles.nameDim : styles.name}>{view.name}</Text>
    </>
  );

  return (
    <View style={styles.hero}>
      {view.visual === 'photo' ? (
        <View style={styles.visual}>
          <PhotoRegion
            card={card}
            {...(photoClient === undefined ? {} : { client: photoClient })}
          />
          <PhotoScrim />
          {view.dimmed ? <View style={styles.veil} /> : null}
          <View style={styles.pillAnchor}>
            <StatusPill opening={view.opening} />
          </View>
          <View style={styles.nameAnchor}>{heading}</View>
        </View>
      ) : (
        // Without a photo the heading becomes the lead surface. Reserving a photo-shaped
        // frame here would read as a broken image rather than as a card that has none.
        <View style={styles.heading}>
          <StatusPill opening={view.opening} />
          <View style={styles.headingText}>{heading}</View>
        </View>
      )}

      <View style={styles.body}>
        <HoursLine dimmed={view.dimmed} opening={view.opening} />
        <MetaLine access={view.access} dimmed={view.dimmed} price={view.price} />
        <AmenityChips amenities={view.amenities} dimmed={view.dimmed} />

        <View style={styles.actionRow}>
          <Pressable
            accessibilityLabel={primaryIsSave ? `${view.name}を残す` : `${view.name}に決める`}
            accessibilityRole="button"
            disabled={primaryIsSave ? saveAction === undefined : decideAction === undefined}
            onPress={primaryIsSave ? saveAction : decideAction}
            style={({ pressed }) => [styles.primaryAction, pressed && styles.pressed]}
          >
            <Text style={styles.primaryActionText}>
              {primaryIsSave ? '明日のために残す' : 'ここにする'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel={primaryIsSave ? `${view.name}に決める` : `${view.name}を残す`}
            accessibilityRole="button"
            disabled={primaryIsSave ? decideAction === undefined : saveAction === undefined}
            onPress={primaryIsSave ? decideAction : saveAction}
            style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryActionText}>{primaryIsSave ? 'ここにする' : '残す'}</Text>
          </Pressable>
        </View>

        <View style={styles.footnoteRow}>
          <Text style={styles.footnote}>掲載の営業時間 · 今の混雑と空席は未確認</Text>
          {onSkip === undefined ? null : (
            <Pressable
              accessibilityLabel={`${view.name}を今夜の候補から外す`}
              accessibilityRole="button"
              onPress={() => onSkip(card.candidateId)}
              style={({ pressed }) => [styles.skip, pressed && styles.pressed]}
            >
              <Text style={styles.skipText}>ちがう</Text>
            </Pressable>
          )}
        </View>

        <AttributionList
          attributions={attributions}
          {...(onSourcePress === undefined ? {} : { onSourcePress })}
        />
      </View>
    </View>
  );
}

type AlternativeRowProps = {
  readonly card: PublicCard;
  readonly view: CardViewModel;
  readonly onChoose?: (candidateId: string) => void;
  readonly photoClient?: JourneyPhotoClient;
};

/** Alternatives sit a full tier below the hero: lighter name, no accent, no actions of their own. */
function AlternativeRow({
  card,
  view,
  onChoose,
  photoClient,
}: AlternativeRowProps): React.JSX.Element {
  const summary = openingSummary(view.opening);
  const meta = [summary, view.access].filter((part): part is string => part !== null).join(' · ');
  return (
    <Pressable
      accessibilityLabel={`${view.name}を主提案にする`}
      accessibilityRole="button"
      disabled={onChoose === undefined}
      onPress={() => onChoose?.(card.candidateId)}
      style={({ pressed }) => [styles.alternative, pressed && styles.pressed]}
    >
      {view.visual === 'photo' ? (
        <View style={styles.thumbnail}>
          <PhotoRegion
            card={card}
            compact
            compactSize={ALT_THUMBNAIL}
            {...(photoClient === undefined ? {} : { client: photoClient })}
          />
        </View>
      ) : null}
      <View style={styles.alternativeBody}>
        <Text numberOfLines={1} style={styles.alternativeName}>
          {view.name}
        </Text>
        {view.diff === null ? null : <Text style={styles.alternativeDiff}>{view.diff}</Text>}
        {meta.length === 0 ? null : (
          <Text numberOfLines={1} style={styles.alternativeMeta}>
            {meta}
          </Text>
        )}
      </View>
      <Chevron />
    </Pressable>
  );
}

export type AttributionListProps = {
  readonly attributions: readonly AttributionPresentation[];
  readonly onSourcePress?: (sourceLink: string) => void;
};

/** Per-source attribution stays on the card; the provider policy requires it to be visible. */
export function AttributionList({
  attributions,
  onSourcePress,
}: AttributionListProps): React.JSX.Element | null {
  if (attributions.length === 0) return null;
  return (
    <View style={styles.attribution}>
      {attributions.map((attribution) => {
        const sourceLink = attribution.sourceLink;
        if (sourceLink !== null && onSourcePress !== undefined) {
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
    backgroundColor: colors.surfaceMuted,
    borderRadius: 26,
    overflow: 'hidden',
  },
  visual: {
    aspectRatio: 0.97,
    backgroundColor: '#222224',
    position: 'relative',
    width: '100%',
  },
  veil: {
    backgroundColor: 'rgba(9, 9, 10, 0.58)',
    pointerEvents: 'none',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  pillAnchor: {
    alignItems: 'flex-start',
    left: 14,
    position: 'absolute',
    top: 14,
  },
  nameAnchor: {
    bottom: 18,
    gap: 7,
    left: 18,
    position: 'absolute',
    right: 18,
  },
  category: {
    color: colors.lime,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  categoryDim: {
    color: '#7f8a5c',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  name: {
    color: '#f4f3ee',
    fontSize: 27,
    fontWeight: '800',
    lineHeight: 34,
  },
  nameDim: {
    color: '#d3d2cd',
    fontSize: 27,
    fontWeight: '800',
    lineHeight: 34,
  },
  heading: {
    backgroundColor: '#1c1c20',
    gap: 14,
    paddingBottom: 18,
    paddingHorizontal: 18,
    paddingTop: 18,
  },
  headingText: {
    gap: 7,
  },
  body: {
    paddingBottom: 18,
    paddingHorizontal: 18,
    paddingTop: 16,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.compact,
    marginTop: 16,
  },
  primaryAction: {
    alignItems: 'center',
    backgroundColor: colors.cream,
    borderRadius: 15,
    flexGrow: 1,
    justifyContent: 'center',
    minHeight: 50,
  },
  primaryActionText: {
    color: colors.ink,
    fontSize: typography.button,
    fontWeight: '700',
  },
  secondaryAction: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: 15,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 50,
    width: 84,
  },
  secondaryActionText: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
  },
  footnoteRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.compact,
    justifyContent: 'space-between',
    marginTop: 14,
    minHeight: 44,
  },
  footnote: {
    color: '#7c7b76',
    flexShrink: 1,
    fontSize: 11,
    lineHeight: 16,
  },
  skip: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 8,
  },
  skipText: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  alternative: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 20,
    flexDirection: 'row',
    gap: 12,
    minHeight: 96,
    padding: 10,
  },
  thumbnail: {
    borderRadius: 15,
    height: ALT_THUMBNAIL,
    overflow: 'hidden',
    width: ALT_THUMBNAIL,
  },
  alternativeBody: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  alternativeName: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
  },
  alternativeDiff: {
    color: '#b9b8b1',
    fontSize: typography.label,
  },
  alternativeMeta: {
    color: '#8f8e88',
    fontSize: 11,
  },
  attribution: {
    columnGap: spacing.compact,
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 6,
  },
  attributionText: {
    color: '#6b6a66',
    fontSize: 11,
  },
  attributionLink: {
    color: '#6b6a66',
    fontSize: 11,
    textDecorationLine: 'underline',
  },
  pressed: {
    opacity: 0.72,
  },
});
