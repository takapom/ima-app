import { HistoricalCards } from '@mobile/journey/components/conversations/HistoricalCards';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AssistantMessageRecord } from '@mobile/journey/state/assistant-response';
import { conversationTranscriptEntries } from '@mobile/journey/services/conversations/conversation-transcript';
import type { ConversationMessage } from '@ima/contracts';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';
import { AttributionList } from '@mobile/ui/AttributionList';

export function ConversationTranscript({
  messages,
  liveCardSetId,
  photoClient,
  liveMessages,
  loading,
  hasOlder,
  onOlder,
  onSourcePress,
  syncError,
  unsyncedTurnId,
  onRetrySync,
}: {
  readonly liveCardSetId: string | null;
  readonly photoClient?: JourneyPhotoClient;
  readonly messages: readonly ConversationMessage[];
  readonly liveMessages: readonly AssistantMessageRecord[];
  readonly loading: boolean;
  readonly hasOlder: boolean;
  readonly onOlder: () => void;
  readonly onSourcePress: (sourceLink: string) => void;
  readonly syncError: string | null;
  readonly unsyncedTurnId: string | null;
  readonly onRetrySync: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.transcript}>
      {hasOlder ? (
        <Pressable
          accessibilityRole="button"
          disabled={loading}
          onPress={onOlder}
          style={styles.more}
        >
          <Text style={styles.muted}>以前のメッセージを表示</Text>
        </Pressable>
      ) : null}
      {loading ? (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          会話を読み込んでいます…
        </Text>
      ) : null}
      {conversationTranscriptEntries(messages, liveMessages, unsyncedTurnId).map((entry) => (
        <View key={entry.messageId} style={[styles.message, entry.role === 'user' && styles.user]}>
          <Text style={styles.role}>{entry.role === 'user' ? 'あなた' : 'ima.'}</Text>
          {entry.parts.map((part, index) =>
            part.kind === 'user_text' || part.kind === 'retained_text' ? (
              <View key={index}>
                <Text selectable style={styles.text}>
                  {part.text}
                </Text>
                {part.kind === 'retained_text' && part.retention.attribution !== null ? (
                  <AttributionList
                    comfortable
                    attributions={[part.retention.attribution]}
                    onSourcePress={onSourcePress}
                  />
                ) : null}
              </View>
            ) : part.kind === 'card_set' ? (
              part.cardSetId === liveCardSetId ? null : (
                <HistoricalCards
                  key={part.cardSetId}
                  part={part}
                  onSourcePress={onSourcePress}
                  {...(photoClient === undefined ? {} : { photoClient })}
                />
              )
            ) : part.kind === 'card_set_reference' ? (
              <Text key={index} style={styles.muted}>
                この提案の店舗情報は保存されていません。
              </Text>
            ) : part.kind === 'unavailable' ? (
              <Text key={index} style={styles.muted}>
                {part.reason === 'expired'
                  ? '保存期限が過ぎたため、この回答は表示できません。'
                  : 'この回答の本文は保存されていません。'}
              </Text>
            ) : null,
          )}
        </View>
      ))}
      {syncError !== null ? (
        <View>
          <Text accessibilityLiveRegion="polite" style={styles.muted}>
            {syncError}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={loading}
            onPress={onRetrySync}
            style={styles.more}
          >
            <Text style={styles.muted}>履歴を再取得</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  transcript: { gap: 18, paddingVertical: spacing.section },
  message: { gap: 8, paddingVertical: 12, paddingHorizontal: 14 },
  user: {
    alignSelf: 'flex-end',
    maxWidth: '90%',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.small,
  },
  role: { color: colors.muted, fontSize: typography.label },
  text: { color: colors.text, fontSize: 16, lineHeight: 25 },
  muted: { color: colors.muted, fontSize: typography.body, lineHeight: 21 },
  more: { minHeight: spacing.touch, justifyContent: 'center', alignItems: 'center' },
});
