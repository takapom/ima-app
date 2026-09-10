import { StyleSheet, Text, View } from 'react-native';
import type { CardsData, PublicMessage } from '@ima/contracts';
import { CandidateCard } from './CandidateCard';
import { colors, spacing, typography } from '../theme/tokens';

type ResultsStateProps = {
  readonly cards: CardsData | null;
  readonly messages: readonly PublicMessage[];
  readonly onChoose?: (candidateId: string) => void;
  readonly onDecide: (candidateId: string) => void;
};

export function ResultsState({
  cards,
  messages,
  onChoose,
  onDecide,
}: ResultsStateProps): React.JSX.Element {
  const latestMessage = messages[messages.length - 1];
  if (cards === null) {
    return (
      <View style={styles.messageOnly}>
        <Text style={styles.messageKicker}>imaから</Text>
        <Text style={styles.messageText}>
          {latestMessage?.text ?? '条件に合う候補を表示できませんでした。'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {latestMessage ? (
        <View style={styles.messageBox}>
          <Text style={styles.messageKicker}>imaから</Text>
          <Text style={styles.messageText}>{latestMessage.text}</Text>
        </View>
      ) : null}
      <Text style={styles.kicker}>主提案</Text>
      <CandidateCard card={cards.hero} onDecide={onDecide} primary />
      {cards.alts.length > 0 ? (
        <View style={styles.alternatives}>
          <View style={styles.altHeading}>
            <Text style={styles.kicker}>別案</Text>
            <Text style={styles.hint}>タップで入れ替え</Text>
          </View>
          {cards.alts.map((card) => (
            <CandidateCard
              card={card}
              key={card.candidateId}
              primary={false}
              {...(onChoose === undefined ? {} : { onChoose })}
            />
          ))}
        </View>
      ) : null}
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
