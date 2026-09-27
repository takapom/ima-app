import { Modal, StyleSheet, Text, View } from 'react-native';
import type { ConversationCards } from '@ima/contracts';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import { CandidateCard } from '@mobile/journey/components/candidates/CandidateCard';
import { CandidateDetailSheet } from '@mobile/journey/components/candidates/CandidateDetailSheet';
import { presentGeneratedText } from '@mobile/journey/components/candidates/candidate-card-model';
import { useCandidateDetail } from '@mobile/journey/hooks/useCandidateDetail';
import { createAssistantResponseState } from '@mobile/journey/state/assistant-response';
import { toCandidateDetailViewModel } from '@mobile/journey/presentation/candidate-detail-view';
import { colors, spacing, typography } from '@mobile/ui/theme/tokens';

/** Historical display has source links and details, but never current-turn candidate actions. */
export function HistoricalCards({
  part,
  onSourcePress,
  photoClient,
}: {
  readonly part: ConversationCards;
  readonly onSourcePress: (url: string) => void;
  readonly photoClient?: JourneyPhotoClient;
}): React.JSX.Element {
  const cards = [part.cards.hero, ...part.cards.alts];
  const now = new Date().toISOString();
  const detail = useCandidateDetail(
    {
      ...createAssistantResponseState(part.threadId),
      cards: part.cards,
      cardSetId: part.cardSetId,
    },
    cards.map((card) => card.candidateId),
    now,
  );
  return (
    <View style={styles.cards}>
      <Text style={styles.label}>提案時の店舗情報</Text>
      {cards.map((card) => (
        <View key={card.candidateId} style={styles.card}>
          <Text style={styles.reason}>{presentGeneratedText(card.why).text}</Text>
          {Object.values(card.facts).some(
            (field) => field !== undefined && field.status !== 'known',
          ) ? (
            <Text style={styles.label}>
              {[
                ...new Set(
                  Object.values(card.facts).flatMap((field) =>
                    field === undefined || field.status === 'known' ? [] : [field.reason],
                  ),
                ),
              ].join(' / ')}
            </Text>
          ) : null}
          <CandidateCard
            card={card}
            now={now}
            onSourcePress={onSourcePress}
            {...(toCandidateDetailViewModel(card, Date.parse(now)).attributions.length === 0
              ? {}
              : { onOpenDetail: detail.open })}
            onPhotoReady={detail.rememberPhoto}
            {...(photoClient === undefined ? {} : { photoClient })}
          />
        </View>
      ))}
      <Modal
        visible={detail.card !== null}
        transparent
        animationType="slide"
        onRequestClose={detail.close}
      >
        <View style={styles.modal}>
          <CandidateDetailSheet
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
  card: { gap: 8 },
  modal: { flex: 1 },
  label: { color: colors.muted, fontSize: typography.label },
  reason: { color: colors.text, fontSize: typography.body, lineHeight: 22 },
});
