import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@mobile/theme/tokens';

type ErrorStateProps = {
  readonly message: string;
  readonly title?: string;
  readonly onRetry?: () => void;
};

export function ErrorState({
  message,
  title = '検索できませんでした',
  onRetry,
}: ErrorStateProps): React.JSX.Element {
  const canRetry = onRetry !== undefined;
  return (
    <View style={styles.container}>
      <Text style={styles.kicker}>{title}</Text>
      <Text style={styles.message}>{message}</Text>
      <Pressable
        accessibilityRole="button"
        disabled={!canRetry}
        onPress={() => onRetry?.()}
        style={({ pressed }) => [
          styles.retry,
          !canRetry && styles.retryDisabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.retryText}>もう一度試す</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: radii.card,
    marginHorizontal: spacing.page,
    marginTop: spacing.section,
    padding: spacing.canvas,
  },
  kicker: {
    color: colors.cream,
    fontSize: typography.body,
    fontWeight: '700',
  },
  message: {
    color: colors.muted,
    fontSize: typography.label,
    lineHeight: 20,
    marginTop: spacing.compact,
  },
  retry: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.button,
    borderWidth: 1,
    marginTop: spacing.section,
    minHeight: spacing.touch,
    justifyContent: 'center',
  },
  retryText: {
    color: colors.text,
    fontSize: typography.button,
    fontWeight: '700',
  },
  retryDisabled: {
    opacity: 0.45,
  },
  pressed: {
    backgroundColor: colors.surface,
  },
});
