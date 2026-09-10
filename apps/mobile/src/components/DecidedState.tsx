import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PublicCard } from '@ima/contracts';
import { presentDecidedIdentity } from './decided-state-model';
import { colors, radii, spacing, typography } from '../theme/tokens';

type DecidedStateProps = {
  readonly card: PublicCard | null;
  readonly notice?: string | null;
  readonly onOpenMap?: () => void;
  readonly onSave?: (card: PublicCard) => void;
  readonly onShare?: () => void;
  readonly onRecover?: () => void;
};

export function DecidedState({
  card,
  notice = null,
  onOpenMap,
  onSave,
  onShare,
  onRecover,
}: DecidedStateProps): React.JSX.Element {
  const identity = presentDecidedIdentity(card);
  return (
    <View style={styles.container}>
      <Text style={styles.kicker}>ここにする</Text>
      <Text style={styles.title}>{identity?.name ?? '候補を決めました'}</Text>
      {identity?.area ? <Text style={styles.area}>{identity.area}</Text> : null}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <View style={styles.actionRow}>
        <Pressable
          accessibilityLabel="徒歩地図を開く"
          accessibilityRole="button"
          disabled={onOpenMap === undefined || card === null}
          onPress={onOpenMap}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text style={styles.actionText}>地図を開く</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="共有シートを開く"
          accessibilityRole="button"
          disabled={onShare === undefined || card === null}
          onPress={onShare}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text style={styles.actionText}>共有</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="決めた候補を残す"
          accessibilityRole="button"
          disabled={onSave === undefined || card === null}
          onPress={() => {
            if (card !== null) onSave?.(card);
          }}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text style={styles.actionText}>残す</Text>
        </Pressable>
      </View>
      <Pressable
        accessibilityLabel="別の候補を探す"
        accessibilityRole="button"
        disabled={onRecover === undefined || card === null}
        onPress={onRecover}
        style={({ pressed }) => [styles.recover, pressed && styles.pressed]}
      >
        <Text style={styles.recoverText}>ちがう候補を探す</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.card,
    marginHorizontal: spacing.page,
    marginTop: spacing.section,
    padding: spacing.canvas,
  },
  kicker: {
    color: colors.lime,
    fontSize: typography.label,
    fontWeight: '700',
  },
  title: {
    color: colors.text,
    fontSize: typography.title,
    fontWeight: '800',
    marginTop: spacing.compact,
  },
  area: {
    color: colors.muted,
    fontSize: typography.label,
    marginTop: 3,
  },
  notice: {
    color: colors.cream,
    fontSize: typography.label,
    lineHeight: 18,
    marginTop: spacing.section,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.compact,
    marginTop: spacing.canvas,
  },
  action: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.button,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: spacing.touch,
  },
  actionText: {
    color: colors.text,
    fontSize: typography.button,
    fontWeight: '700',
  },
  recover: {
    alignItems: 'center',
    backgroundColor: colors.cream,
    borderRadius: radii.button,
    justifyContent: 'center',
    marginTop: spacing.compact,
    minHeight: spacing.touch,
  },
  recoverText: {
    color: colors.ink,
    fontSize: typography.button,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.72,
  },
});
