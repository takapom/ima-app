import { Pressable, Text, View } from 'react-native';
import type { PublicCard } from '@ima/contracts';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import {
  cardRenderNow,
  toCardViewModel,
  cardOpeningSummary,
} from '@mobile/journey/presentation/candidate-card-view';
import { PhotoRegion } from '@mobile/journey/components/candidates/PhotoRegion';
import { colors } from '@mobile/ui/theme/tokens';
import { Icon } from '@mobile/ui/Icon';
import type { RememberPhoto } from '@mobile/journey/state/photo-image-state';
import {
  styles,
  CANDIDATE_THUMBNAIL_SIZE,
} from '@mobile/journey/components/candidates/candidate-card-styles';

type CandidateCardProps = {
  readonly card: PublicCard;
  /** Injected render time; the countdown is resolved here, never baked in upstream. */
  readonly now?: string;
  readonly onOpenDetail?: (candidateId: string) => void;
  readonly onSourcePress: (sourceLink: string) => void;
  readonly onPhotoReady?: RememberPhoto;
  readonly onSave?: (card: PublicCard) => void;
  readonly photoClient?: JourneyPhotoClient;
};

export function CandidateCard({
  card,
  now,
  onOpenDetail,
  onSourcePress,
  onPhotoReady,
  onSave,
  photoClient,
}: CandidateCardProps): React.JSX.Element {
  const view = toCardViewModel(card, cardRenderNow(now));
  const { sourceUrl } = view;

  const saveAction = onSave === undefined ? undefined : (): void => onSave(card);
  const openDetails = (): void => onOpenDetail?.(card.candidateId);
  const primaryIsSave = view.primaryAction === 'save';
  const opening = cardOpeningSummary(view.opening);

  return (
    <View style={styles.card}>
      <View style={styles.summary}>
        {view.visual === 'photo' ? (
          <View style={styles.thumbnail}>
            <PhotoRegion
              card={card}
              compact
              compactSize={CANDIDATE_THUMBNAIL_SIZE}
              {...(onPhotoReady === undefined ? {} : { onPhotoReady })}
              {...(photoClient === undefined ? {} : { client: photoClient })}
            />
          </View>
        ) : null}
        <View style={styles.heading}>
          {view.category === null ? null : (
            <Text numberOfLines={1} style={styles.category}>
              {view.category}
            </Text>
          )}
          <Text numberOfLines={2} style={[styles.name, view.dimmed && styles.dimmedText]}>
            {view.name}
          </Text>
          {view.diff === null ? null : (
            <Text numberOfLines={1} style={styles.diff}>
              {view.diff}
            </Text>
          )}
        </View>
      </View>
      {opening === null ? null : (
        <Text
          numberOfLines={1}
          style={[styles.meta, view.opening.kind === 'closing' && styles.closing]}
        >
          {opening}
        </Text>
      )}
      {view.access === null && view.price === null ? null : (
        <View style={styles.metaRow}>
          {view.access === null ? null : (
            <Text numberOfLines={1} style={[styles.meta, styles.access]}>
              {view.access}
            </Text>
          )}
          {view.price === null ? null : (
            <Text numberOfLines={1} style={[styles.meta, styles.price]}>
              {view.price}
            </Text>
          )}
        </View>
      )}
      {sourceUrl === null ? null : (
        <Pressable
          accessibilityLabel={`${view.name}の店舗ページを開く`}
          accessibilityRole="link"
          onPress={() => onSourcePress(sourceUrl)}
          style={({ pressed }) => [styles.sourceLink, pressed && styles.pressed]}
        >
          <Text numberOfLines={1} ellipsizeMode="tail" style={styles.sourceUrl}>
            {sourceUrl}
          </Text>
          <Text accessible={false} style={styles.meta}>
            ↗
          </Text>
        </Pressable>
      )}
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
          <Text style={styles.primaryActionText}>{primaryIsSave ? '残す' : '詳細を見る'}</Text>
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
    </View>
  );
}
