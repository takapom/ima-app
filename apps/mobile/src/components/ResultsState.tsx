import { StyleSheet, Text, View } from 'react-native';
import type { CardsData, PublicCard } from '@ima/contracts';
import { CandidateCard } from './CandidateCard';
import {
  buildMessageHistory,
  cardSetStatusLabel,
  type MessageHistoryItem,
} from './results-state-model';
import type { AssistantMessageRecord, CardSetDisplayState } from '../state/assistant-response';
import type { JourneyPhotoClient } from '../services/api/photo-client';
import { colors, spacing, typography } from '../theme/tokens';

type ResultsStateProps = {
  readonly cards: CardsData | null;
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
  const statusLabel = cardSetStatusLabel(cardSetDisplay);
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
      <MessageHistory items={messageHistory} />
      <Text style={styles.kicker}>主提案</Text>
      <CandidateCard
        card={hero}
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
  if (items.length === 0) {
    return fallback ? <Text style={styles.messageText}>{fallback}</Text> : null;
  }
  return (
    <View style={styles.messageHistory}>
      {items.map((item) => (
        <View key={item.key} style={styles.messageBox}>
          <Text style={styles.messageKicker}>imaから</Text>
          <Text style={styles.messageText}>
            {item.message?.text ??
              (item.displayPolicyStatus === 'expired'
                ? 'このメッセージは表示期限を過ぎています。'
                : 'このメッセージは現在表示できません。')}
          </Text>
          <Text style={styles.messageRelation}>
            {item.relation === 'current'
              ? '表示中の候補'
              : item.relation === 'past'
                ? '過去の候補'
                : '候補なし'}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.compact,
    paddingHorizontal: spacing.page,
    paddingTop: spacing.compact,
  },
  messageBox: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: 18,
    padding: spacing.section,
  },
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
  messageKicker: {
    color: colors.lime,
    fontSize: typography.label,
    fontWeight: '700',
  },
  messageText: {
    color: colors.text,
    fontSize: typography.body,
    lineHeight: 22,
    marginTop: 4,
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
