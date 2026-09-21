import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Conversation } from '@ima/contracts';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

export type ConversationNavigation = {
  readonly conversations: readonly Conversation[];
  readonly selectedId: string | null;
  readonly unavailable: boolean;
  readonly hasMore: boolean;
  readonly onSelect: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onMore: () => void;
  readonly onRefresh: () => void;
};
export function ConversationHistoryList({
  navigation,
  onClose,
}: {
  readonly navigation: ConversationNavigation;
  readonly onClose: () => void;
}): React.JSX.Element {
  const remove = (conversation: Conversation) =>
    Alert.alert('会話を削除', `「${conversation.title}」を削除します。この操作は取り消せません。`, [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除',
        style: 'destructive',
        onPress: () => navigation.onDelete(conversation.conversationId),
      },
    ]);
  return (
    <View style={styles.list}>
      <Text style={styles.title}>会話履歴</Text>
      {navigation.unavailable ? (
        <View>
          <Text style={styles.muted}>履歴を取得できませんでした。</Text>
          <Pressable
            accessibilityRole="button"
            onPress={navigation.onRefresh}
            style={styles.button}
          >
            <Text style={styles.link}>再取得</Text>
          </Pressable>
        </View>
      ) : null}
      {!navigation.unavailable && navigation.conversations.length === 0 ? (
        <Text style={styles.muted}>メッセージを送ると、ここに会話が残ります。</Text>
      ) : null}
      {navigation.conversations.map((conversation) => (
        <View
          key={conversation.conversationId}
          style={[
            styles.row,
            conversation.conversationId === navigation.selectedId && styles.selected,
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: conversation.conversationId === navigation.selectedId }}
            accessibilityLabel={conversation.title}
            style={styles.select}
            onPress={() => {
              navigation.onSelect(conversation.conversationId);
              onClose();
            }}
          >
            <Text numberOfLines={2} style={styles.label}>
              {conversation.title}
            </Text>
            <Text style={styles.date}>
              {new Date(conversation.updatedAt).toLocaleDateString('ja-JP')}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${conversation.title}を削除`}
            style={styles.delete}
            onPress={() => remove(conversation)}
          >
            <Text style={styles.muted}>削除</Text>
          </Pressable>
        </View>
      ))}
      {navigation.hasMore ? (
        <Pressable accessibilityRole="button" style={styles.button} onPress={navigation.onMore}>
          <Text style={styles.link}>もっと見る</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  list: { gap: 8 },
  title: { color: colors.muted, fontSize: typography.label, marginVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', borderRadius: radii.small },
  selected: { backgroundColor: colors.surfaceRaised },
  select: { flex: 1, minHeight: spacing.touch, padding: 12, gap: 5 },
  label: { color: colors.text, fontSize: typography.body, lineHeight: 21 },
  date: { color: colors.muted, fontSize: 11 },
  delete: { minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  muted: { color: colors.muted, fontSize: typography.label, lineHeight: 19 },
  button: { minHeight: spacing.touch, justifyContent: 'center' },
  link: { color: colors.lime, fontSize: typography.body },
});
