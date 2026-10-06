import { Modal, StyleSheet, Text, View } from 'react-native';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { HistoricalPhoto } from '@mobile/journey/components/conversations/HistoricalPhoto';
import type { ConversationCards } from '@ima/contracts';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import { CandidateCard } from '@mobile/journey/components/candidates/CandidateCard';
import { CandidateCarousel } from '@mobile/journey/components/candidates/CandidateCarousel';
import { CandidateDetailSheet } from '@mobile/journey/components/candidates/CandidateDetailSheet';
import { useCandidateDetail } from '@mobile/journey/hooks/useCandidateDetail';
import { useCardSetFocusEntry } from '@mobile/journey/hooks/useCardSetFocusEntry';
import type { CardSetFocus } from '@mobile/journey/state/card-set-focus';
import { createAssistantResponseState } from '@mobile/journey/state/assistant-response';
import { toCandidateDetailViewModel } from '@mobile/journey/presentation/candidate-detail-view';
import { colors, spacing, typography } from '@mobile/ui/theme/tokens';
import type {
  HistoryPhotoRange,
  HistoryPhotoViewport,
} from '@mobile/journey/state/history-photo-viewport';

/** Historical display has source links and details, but never current-turn candidate actions. */
export function HistoricalCards({
  part,
  onSourcePress,
  photoClient,
  conversationId,
  sequence,
  messageTop,
  photoViewport,
  cardFocus,
}: {
  readonly part: ConversationCards;
  readonly onSourcePress: (url: string) => void;
  readonly photoClient?: JourneyPhotoClient;
  readonly conversationId: string;
  readonly sequence: number;
  readonly messageTop: number | null;
  readonly photoViewport: HistoryPhotoViewport;
  readonly cardFocus: CardSetFocus;
}): React.JSX.Element {
  const [localPhotoRange, setLocalPhotoRange] = useState<HistoryPhotoRange | null>(null);
  const photoRange =
    messageTop === null || localPhotoRange === null
      ? null
      : {
          top: messageTop + localPhotoRange.top,
          bottom: messageTop + localPhotoRange.bottom,
        };
  const subscribe = useCallback(
    (listener: () => void) => photoViewport.subscribe(listener),
    [photoViewport],
  );
  const photosVisible = useSyncExternalStore(
    subscribe,
    () => photoViewport.visible(photoRange),
    () => false,
  );
  const cards = useMemo(() => [part.cards.hero, ...part.cards.alts], [part.cards]);
  const showCard = useCardSetFocusEntry(cardFocus, part.cardSetId, cards, photoRange);
  const now = new Date().toISOString();
  const photoFor = (candidateId: string, active = photosVisible) =>
    photoClient?.fetchConversationPhoto !== undefined &&
    part.photoCandidateIds?.includes(candidateId) ? (
      <HistoricalPhoto
        key={`${conversationId}:${sequence}:${candidateId}`}
        path={{ conversationId, sequence, candidateId }}
        fetchPhoto={photoClient.fetchConversationPhoto}
        active={active}
      />
    ) : undefined;
  const detail = useCandidateDetail(
    {
      ...createAssistantResponseState(part.threadId),
      cards: part.cards,
      cardSetId: part.cardSetId,
    },
    cards.map((card) => card.candidateId),
    now,
    part.photoCandidateIds,
  );
  return (
    <View
      onLayout={({ nativeEvent }) => {
        const top = nativeEvent.layout.y;
        setLocalPhotoRange({ top, bottom: top + nativeEvent.layout.height });
      }}
      style={styles.cards}
    >
      <Text style={styles.label}>提案時の店舗情報</Text>
      {part.photoCandidateIds?.length ? (
        <Text style={styles.label}>写真は現在の店舗写真です。画像提供：ホットペッパー グルメ</Text>
      ) : null}
      <CandidateCarousel
        cards={cards}
        onIndexChange={showCard}
        renderCard={(card) => (
          <View style={styles.card}>
            {Object.entries(card.facts).some(
              ([name, field]) =>
                !(name === 'photos' && part.photoCandidateIds?.includes(card.candidateId)) &&
                field !== undefined &&
                field.status !== 'known',
            ) ? (
              <Text style={styles.label}>
                {[
                  ...new Set(
                    Object.entries(card.facts).flatMap(([name, field]) =>
                      (name === 'photos' && part.photoCandidateIds?.includes(card.candidateId)) ||
                      field === undefined ||
                      field.status === 'known'
                        ? []
                        : [field.reason],
                    ),
                  ),
                ].join(' / ')}
              </Text>
            ) : null}
            <CandidateCard
              photo={photoFor(card.candidateId)}
              card={card}
              fill
              now={now}
              {...(toCandidateDetailViewModel(card, Date.parse(now)).attributions.length === 0 &&
              !part.photoCandidateIds?.includes(card.candidateId)
                ? {}
                : { onOpenDetail: detail.open })}
              onPhotoReady={detail.rememberPhoto}
              {...(photoClient === undefined ? {} : { photoClient })}
            />
          </View>
        )}
      />
      <Modal
        visible={detail.card !== null}
        transparent
        animationType="slide"
        onRequestClose={detail.close}
      >
        <View style={styles.modal}>
          <CandidateDetailSheet
            photoCaption={
              detail.card !== null && part.photoCandidateIds?.includes(detail.card.candidateId)
                ? '現在の店舗写真・画像提供：ホットペッパー グルメ'
                : undefined
            }
            photo={detail.card === null ? undefined : photoFor(detail.card.candidateId, true)}
            detail={detail}
            onSourcePress={onSourcePress}
            {...(photoClient === undefined ? {} : { photoClient })}
          />
        </View>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create({
  cards: { gap: spacing.compact },
  card: { flex: 1, gap: 8 },
  modal: { flex: 1 },
  label: { color: colors.muted, fontSize: typography.label },
});
