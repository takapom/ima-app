import { Pressable, Text, View } from 'react-native';
import type { PublicCard } from '@ima/contracts';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import {
  cardActions,
  cardOpeningSummary,
  cardRenderNow,
  toCardViewModel,
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
  const actions = cardActions(view);
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
          accessibilityLabel={actions.peek.accessibilityLabel}
          accessibilityRole="button"
          hitSlop={4}
          onPress={openDetails}
          style={({ pressed }) => [styles.peekAction, pressed && styles.pressed]}
        >
          <Text style={styles.peekActionText}>{actions.peek.label}</Text>
          <Icon name="chevron" size={11} color={colors.ink} />
        </Pressable>
        <Pressable
          accessibilityLabel={actions.save.accessibilityLabel}
          accessibilityRole="button"
          disabled={saveAction === undefined}
          hitSlop={4}
          onPress={saveAction}
          style={({ pressed }) => [
            styles.saveAction,
            actions.save.emphasized && styles.saveActionEmphasized,
            saveAction === undefined && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Icon
            name="bookmark"
            size={15}
            color={actions.save.emphasized ? colors.ink : colors.muted}
          />
        </Pressable>
      </View>
    </View>
  );
}
