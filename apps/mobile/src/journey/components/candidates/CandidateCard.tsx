import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PublicCard } from '@ima/contracts';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import {
  cardRenderNow,
  toCardViewModel,
  type CardOpening,
  type CardViewModel,
} from '@mobile/journey/presentation/candidate-card-view';
import {
  AmenityChips,
  Chevron,
  HoursLine,
  MetaLine,
  PhotoScrim,
  StatusPill,
} from '@mobile/journey/components/candidates/CandidateCardParts';
import { PhotoRegion } from '@mobile/journey/components/candidates/PhotoRegion';
import { colors } from '@mobile/ui/theme/tokens';
import { Icon } from '@mobile/ui/Icon';
import { LinearGradient } from '@mobile/ui/LinearGradient';
import { CandidateDetails } from '@mobile/journey/components/candidates/CandidateDetails';
import { styles } from '@mobile/journey/components/candidates/candidate-card-styles';

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
  const [detailsOpen, setDetailsOpen] = useState(false);

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
  const openDetails = (): void => setDetailsOpen(true);
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
          {view.dimmed ? <View style={styles.veil} /> : null}
          <PhotoScrim />
          <View style={styles.pillAnchor}>
            <StatusPill opening={view.opening} />
          </View>
          <View style={styles.nameAnchor}>{heading}</View>
        </View>
      ) : (
        // Without a photo the heading becomes the lead surface. Reserving a photo-shaped
        // frame here would read as a broken image rather than as a card that has none.
        <View style={styles.heading}>
          <LinearGradient
            value="linear-gradient(162deg, #24232a 0%, #1a1a1e 60%, #151517 100%)"
            style={styles.headingGradient}
          />
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
            accessibilityLabel={primaryIsSave ? `${view.name}を残す` : `${view.name}の詳細を見る`}
            accessibilityRole="button"
            disabled={primaryIsSave ? saveAction === undefined : false}
            onPress={primaryIsSave ? saveAction : openDetails}
            style={({ pressed }) => [
              styles.primaryAction,
              primaryIsSave && saveAction === undefined && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {primaryIsSave ? <Icon name="bookmark" size={14} color={colors.ink} /> : null}
            <Text style={styles.primaryActionText}>
              {primaryIsSave ? '明日のために残す' : '詳細を見る'}
            </Text>
            {primaryIsSave ? null : <Icon name="chevron" size={12} color={colors.ink} />}
          </Pressable>
          <Pressable
            accessibilityLabel={primaryIsSave ? `${view.name}の詳細を見る` : `${view.name}を残す`}
            accessibilityRole="button"
            disabled={primaryIsSave ? false : saveAction === undefined}
            onPress={primaryIsSave ? openDetails : saveAction}
            style={({ pressed }) => [
              styles.secondaryAction,
              !primaryIsSave && saveAction === undefined && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Icon name={primaryIsSave ? 'chevron' : 'bookmark'} size={14} color={colors.muted} />
            <Text style={styles.secondaryActionText}>{primaryIsSave ? '詳細' : '残す'}</Text>
          </Pressable>
        </View>

        <Text style={styles.footnote}>掲載の営業時間 · 今の混雑と空席は未確認</Text>
      </View>
      <CandidateDetails
        card={card}
        view={view}
        visible={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        {...(onDecide === undefined ? {} : { onDecide })}
        {...(onSave === undefined ? {} : { onSave })}
        {...(onSkip === undefined ? {} : { onSkip })}
        {...(onSourcePress === undefined ? {} : { onSourcePress })}
      />
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
