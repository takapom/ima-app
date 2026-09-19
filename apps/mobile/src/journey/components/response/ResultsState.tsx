import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CardsData, PublicCard } from '@ima/contracts';
import { CandidateCard } from '@mobile/journey/components/candidates/CandidateCard';
import { presentEvidenceText } from '@mobile/journey/components/candidates/candidate-card-model';
import {
  buildMessageHistory,
  cardSetStatusLabel,
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
  readonly onChoose?: (candidateId: string) => void;
  readonly onDecide: (candidateId: string) => void;
  readonly onSave?: (card: PublicCard) => void;
  readonly onSkip?: (candidateId: string) => void;
  readonly onSourcePress?: (sourceLink: string) => void;
  readonly photoClient?: JourneyPhotoClient;
};

const orderedCards = (
  cards: CardsData,
  candidateOrder: readonly string[] | undefined,
): readonly PublicCard[] => {
  const source = [cards.hero, ...cards.alts];
  const order = candidateOrder ?? source.map((card) => card.candidateId);
  return order.flatMap((candidateId) => {
    const card = source.find((item) => item.candidateId === candidateId);
    return card === undefined ? [] : [card];
  });
};

export function ResultsState({
  cards,
  now,
  cardSetId,
  cardSetDisplay,
  messageRecords,
  candidateOrder,
  notice = null,
  onChoose,
  onDecide,
  onSave,
  onSkip,
  onSourcePress,
  photoClient,
}: ResultsStateProps): React.JSX.Element {
  const displayCards = cards === null ? [] : orderedCards(cards, candidateOrder);
  const messageHistory = buildMessageHistory(messageRecords, cardSetId, displayCards.length > 0);
  const statusLabel = cardSetStatusLabel(cardSetDisplay, messageHistory.length > 0);
  if (displayCards.length === 0) {
    return (
      <View style={styles.messageOnly}>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {statusLabel ? <Text style={styles.statusLabel}>{statusLabel}</Text> : null}
        <MessageHistory items={messageHistory} fallback="候補はまだ提示されていません。" />
      </View>
    );
  }

  const [hero, ...alternatives] = displayCards;
  if (hero === undefined) return <View />;

  return (
    <View style={styles.container}>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {statusLabel ? <Text style={styles.statusLabel}>{statusLabel}</Text> : null}
      <MessageHistory items={messageHistory} fallback={presentEvidenceText(hero.why).text} />
      <CandidateCard
        key={hero.candidateId}
        card={hero}
        {...(now === undefined ? {} : { now })}
        onDecide={onDecide}
        {...(onSave === undefined ? {} : { onSave })}
        {...(onSkip === undefined ? {} : { onSkip })}
        primary
        {...(onSourcePress === undefined ? {} : { onSourcePress })}
        {...(photoClient === undefined ? {} : { photoClient })}
      />
      {alternatives.length > 0 ? (
        <View style={styles.alternatives}>
          <View style={styles.altHeading}>
            <Text style={styles.kicker}>別案</Text>
            <Text style={styles.hint}>タップで入れ替え</Text>
          </View>
          {alternatives.map((card) => (
            <CandidateCard
              card={card}
              key={card.candidateId}
              {...(now === undefined ? {} : { now })}
              primary={false}
              {...(onChoose === undefined ? {} : { onChoose })}
              {...(onSourcePress === undefined ? {} : { onSourcePress })}
              {...(photoClient === undefined ? {} : { photoClient })}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

type MessageHistoryProps = {
  readonly items: readonly MessageHistoryItem[];
  readonly fallback?: string;
};

function MessageHistory({ items, fallback }: MessageHistoryProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) {
    return fallback ? (
      <View style={styles.messageBox}>
        <View style={styles.messageDot} />
        <Text style={[styles.messageText, styles.messageBody]}>{fallback}</Text>
      </View>
    ) : null;
  }
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
  kicker: {
    color: colors.muted,
    fontSize: typography.label,
    fontWeight: '700',
  },
  alternatives: {
    gap: 6,
    marginTop: spacing.section,
  },
  altHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  hint: {
    color: colors.faint,
    fontSize: 11,
  },
});
