import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

type SavedPlaceConsultationBannerProps = {
  readonly onClear: () => void;
  readonly disabled?: boolean;
};

export function SavedPlaceConsultationBanner({
  onClear,
  disabled = false,
}: SavedPlaceConsultationBannerProps): React.JSX.Element {
  return (
    <View accessibilityLabel="保存した店を相談に使用" style={styles.container}>
      <Text style={styles.text}>保存した店を次の相談に使用します</Text>
      <Pressable
        accessibilityLabel="保存した店の相談指定を解除"
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onClear}
        style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
      >
        <Text style={styles.clearText}>解除</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  clear: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.button,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: spacing.touch,
    paddingHorizontal: spacing.section,
  },
  clearText: {
    color: colors.text,
    fontSize: typography.label,
    fontWeight: '700',
  },
  container: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: radii.button,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginHorizontal: spacing.page,
    marginTop: spacing.compact,
    paddingHorizontal: spacing.section,
    paddingVertical: spacing.compact,
  },
  pressed: {
    opacity: 0.72,
  },
  text: {
    color: colors.muted,
    flex: 1,
    fontSize: typography.label,
    marginRight: spacing.compact,
  },
});
