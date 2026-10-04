import { Pressable, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import type { PublicCard } from '@ima/contracts';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import {
  cardActions,
  cardOpeningSummary,
  cardRenderNow,
  toCardViewModel,
} from '@mobile/journey/presentation/candidate-card-view';
import { googleMapsSearchUrlFor } from '@mobile/journey/services/journey-map';
import { PhotoRegion } from '@mobile/journey/components/candidates/PhotoRegion';
import { colors } from '@mobile/ui/theme/tokens';
import { Icon } from '@mobile/ui/Icon';
import type { RememberPhoto } from '@mobile/journey/state/photo-image-state';
import {
  styles,
  CANDIDATE_THUMBNAIL_SIZE,
} from '@mobile/journey/components/candidates/candidate-card-styles';

type CandidateCardProps = {
  readonly photo?: ReactNode;
  readonly card: PublicCard;
  /** Injected render time; the countdown is resolved here, never baked in upstream. */
  readonly now?: string;
  readonly onOpenDetail?: (candidateId: string) => void;
  readonly onOpenMap?: (card: PublicCard) => void;
  readonly onPhotoReady?: RememberPhoto;
  readonly onSave?: (card: PublicCard) => void;
  readonly photoClient?: JourneyPhotoClient;
};

export function CandidateCard({
  photo,
  card,
  now,
  onOpenDetail,
  onOpenMap,
  onPhotoReady,
  onSave,
  photoClient,
}: CandidateCardProps): React.JSX.Element {
  const view = toCardViewModel(card, cardRenderNow(now));

  const saveAction = onSave === undefined ? undefined : (): void => onSave(card);
  const openDetails = (): void => onOpenDetail?.(card.candidateId);
  const openMap = (): void => onOpenMap?.(card);
  const actions = cardActions(view);
  const opening = cardOpeningSummary(view.opening);
  const canOpenMap = onOpenMap !== undefined && googleMapsSearchUrlFor(card) !== null;

  return (
    <View style={styles.card}>
      <View style={styles.summary}>
        {photo !== undefined ? (
          <View style={styles.thumbnail}>{photo}</View>
        ) : view.visual === 'photo' ? (
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
          {view.access === null ? null : <FactLine icon="train" text={view.access} />}
          {opening === null ? null : (
            <FactLine icon="clock" text={opening} emphasized={view.opening.kind === 'closing'} />
          )}
          {view.price === null ? null : <FactLine icon="yen" text={view.price} />}
        </View>
        {saveAction === undefined && !canOpenMap ? null : (
          <View style={styles.sideActions}>
            {saveAction === undefined ? null : (
              <Pressable
                accessibilityLabel={actions.save.accessibilityLabel}
                accessibilityRole="button"
                hitSlop={4}
                onPress={saveAction}
                style={({ pressed }) => [
                  styles.iconAction,
                  actions.save.emphasized && styles.saveActionEmphasized,
                  pressed && styles.pressed,
                ]}
              >
                <Icon
                  name="bookmark"
                  size={18}
                  color={actions.save.emphasized ? colors.ink : colors.text}
                />
              </Pressable>
            )}
            {canOpenMap ? (
              <Pressable
                accessibilityLabel={actions.map.accessibilityLabel}
                accessibilityRole="link"
                hitSlop={4}
                onPress={openMap}
                style={({ pressed }) => [styles.iconAction, pressed && styles.pressed]}
              >
                <Icon name="mapPin" size={18} color={colors.lime} />
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
      <Pressable
        accessibilityLabel={actions.details.accessibilityLabel}
        accessibilityRole="button"
        hitSlop={4}
        onPress={openDetails}
        disabled={onOpenDetail === undefined}
        style={({ pressed }) => [
          styles.detailsAction,
          onOpenDetail === undefined && styles.disabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.detailsActionText}>{actions.details.label}</Text>
        <Icon name="chevron" size={16} color={colors.ink} />
      </Pressable>
    </View>
  );
}

function FactLine({
  icon,
  text,
  emphasized = false,
}: {
  readonly icon: 'clock' | 'train' | 'yen';
  readonly text: string;
  readonly emphasized?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.factLine}>
      <View style={styles.factIcon}>
        <Icon name={icon} size={15} color={emphasized ? colors.lime : colors.muted} />
      </View>
      <Text numberOfLines={2} style={[styles.meta, emphasized && styles.closing]}>
        {text}
      </Text>
    </View>
  );
}
