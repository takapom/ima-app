import { useState } from 'react';
import type { RememberPhoto } from '@mobile/journey/state/photo-image-state';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CardsData, PublicCard } from '@ima/contracts';
import { CandidateCard } from '@mobile/journey/components/candidates/CandidateCard';
import { CandidateCarousel } from '@mobile/journey/components/candidates/CandidateCarousel';
import {
  buildMessageHistory,
  cardSetStatusLabel,
  orderedResultCards,
  type MessageHistoryItem,
} from '@mobile/journey/components/response/results-state-model';
import type {
  AssistantMessageRecord,
  CardSetDisplayState,
} from '@mobile/journey/state/assistant-response';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import { colors, spacing, typography } from '@mobile/ui/theme/tokens';

type ResultsStateProps = {
  readonly cards: CardsData | null;
  /** Injected render time; cards resolve their opening countdown against it. */
  readonly now?: string;
  readonly cardSetId: string | null;
  readonly cardSetDisplay: CardSetDisplayState;
  readonly messageRecords: readonly AssistantMessageRecord[];
  readonly candidateOrder?: readonly string[];
  readonly notice?: string | null;
  readonly onOpenDetail: (candidateId: string) => void;
  readonly onOpenMap?: (card: PublicCard) => void;
  readonly onPhotoReady?: RememberPhoto;
  readonly onSave?: (card: PublicCard) => void;
  readonly photoClient?: JourneyPhotoClient;
};

export function ResultsState({
  cards,
  now,
  cardSetId,
  cardSetDisplay,
  messageRecords,
  candidateOrder,
  notice = null,
  onOpenDetail,
  onOpenMap,
  onPhotoReady,
  onSave,
  photoClient,
}: ResultsStateProps): React.JSX.Element | null {
  const displayCards = cards === null ? [] : orderedResultCards(cards, candidateOrder);
  const messageHistory = buildMessageHistory(messageRecords, cardSetId, displayCards.length > 0);
  const statusLabel = cardSetStatusLabel(cardSetDisplay);
  if (displayCards.length === 0) {
    // Without cards there is nothing to add beside the conversation; the chat dog shows the state.
    if (!notice && !statusLabel && messageHistory.length === 0) return null;
    return (
      <View style={styles.messageOnly}>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {statusLabel ? <Text style={styles.statusLabel}>{statusLabel}</Text> : null}
        <MessageHistory items={messageHistory} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {statusLabel ? <Text style={styles.statusLabel}>{statusLabel}</Text> : null}
      <MessageHistory items={messageHistory} />
      <CandidateCarousel
        key={cardSetId ?? 'cards'}
        cards={displayCards}
        renderCard={(card) => (
          <CandidateCard
            card={card}
            fill
            {...(now === undefined ? {} : { now })}
            onOpenDetail={onOpenDetail}
            {...(onOpenMap === undefined ? {} : { onOpenMap })}
            {...(onPhotoReady === undefined ? {} : { onPhotoReady })}
            {...(onSave === undefined ? {} : { onSave })}
            {...(photoClient === undefined ? {} : { photoClient })}
          />
        )}
      />
      <Text style={styles.footnote}>掲載の営業時間 · 今の混雑と空席は未確認</Text>
    </View>
  );
}

type MessageHistoryProps = {
  readonly items: readonly MessageHistoryItem[];
};

function MessageHistory({ items }: MessageHistoryProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  return (
    <View style={styles.messageHistory}>
      {items.length > 1 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          style={styles.historyToggle}
        >
          <Text style={styles.historyLabel}>
            {expanded ? '前のやりとりを閉じる' : `前のやりとり ${items.length - 1}件`}
          </Text>
        </Pressable>
      ) : null}
      {(expanded ? items : items.slice(-1)).map((item) => (
        <View key={item.key} style={styles.messageBox}>
          <View style={styles.messageDot} />
          <View style={styles.messageBody}>
            <Text style={styles.messageText}>
              {item.message?.text ??
                (item.displayPolicyStatus === 'expired'
                  ? 'このメッセージは表示期限を過ぎています。'
                  : 'このメッセージは現在表示できません。')}
            </Text>
            {item.relation === 'past' ? (
              <Text style={styles.messageRelation}>過去の候補</Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 14,
    paddingHorizontal: spacing.page,
    paddingTop: 10,
  },
  messageBox: {
    flexDirection: 'row',
    gap: 9,
    paddingHorizontal: 4,
  },
  messageDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.lime, marginTop: 7 },
  messageBody: { flex: 1 },
  historyToggle: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  historyLabel: { color: colors.muted, fontSize: 12 },
  messageHistory: {
    gap: spacing.compact,
  },
  messageOnly: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 18,
    marginHorizontal: spacing.page,
    marginTop: spacing.section,
    padding: spacing.section,
  },
  messageText: {
    color: '#7c7b76',
    fontSize: 13,
    lineHeight: 20,
  },
  messageRelation: {
    color: colors.faint,
    fontSize: typography.label,
    marginTop: spacing.compact,
  },
  statusLabel: {
    color: colors.lime,
    fontSize: typography.label,
    fontWeight: '700',
  },
  notice: {
    color: colors.cream,
    fontSize: typography.label,
    fontWeight: '700',
  },
  footnote: { color: colors.faint, fontSize: typography.label },
});
