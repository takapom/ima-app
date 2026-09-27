import { useEffect } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@mobile/ui/Icon';
import { paddingWithSafeArea } from '@mobile/ui/theme/safe-area';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';
import {
  settingsPreparingLabel,
  settingsSections,
} from '@mobile/settings/presentation/settings-sections';

type SettingsScreenProps = {
  readonly open: boolean;
  readonly onClose: () => void;
};

/**
 * 設定の全画面。どの行も表示だけで操作を受け付けないため、値や状態の代わりに準備中を出す。
 */
export function SettingsScreen({ open, onClose }: SettingsScreenProps): React.JSX.Element | null {
  const insets = useSafeAreaInsets();
  useEffect(() => {
    // Canvasのキーボード回避でこの全画面が縮まないよう、開いた時点で入力を閉じる。
    if (open) Keyboard.dismiss();
  }, [open]);
  if (!open) return null;

  return (
    <View
      accessibilityViewIsModal
      onAccessibilityEscape={onClose}
      style={[
        styles.screen,
        {
          paddingBottom: paddingWithSafeArea(spacing.page, insets.bottom),
          paddingTop: Math.max(20, paddingWithSafeArea(spacing.compact, insets.top)),
        },
      ]}
    >
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          設定
        </Text>
        <Pressable
          accessibilityLabel="設定を閉じる"
          accessibilityRole="button"
          hitSlop={8}
          onPress={onClose}
          style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
        >
          <Icon name="close" color={colors.muted} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} style={styles.scroll}>
        {settingsSections.map((section) => (
          <View key={section.id} style={styles.section}>
            <Text style={styles.sectionLabel}>{section.title}</Text>
            {section.rows.map((row) => (
              <View key={row.id} style={styles.row}>
                <Text style={styles.rowLabel}>{row.label}</Text>
                <Text style={styles.rowStatus}>{settingsPreparingLabel}</Text>
              </View>
            ))}
          </View>
        ))}
        <Text style={styles.note}>
          項目の並びだけを用意しています。どの設定もまだ変更できません。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    bottom: 0,
    left: 0,
    paddingHorizontal: spacing.page,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 10,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: spacing.touch,
  },
  title: {
    color: colors.text,
    fontSize: typography.cardTitle,
    fontWeight: '700',
  },
  closeButton: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  pressed: {
    opacity: 0.72,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingBottom: spacing.canvas,
    paddingTop: spacing.section,
  },
  section: {
    marginBottom: spacing.canvas,
  },
  sectionLabel: {
    color: colors.faint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    paddingHorizontal: spacing.compact,
    paddingVertical: spacing.compact,
  },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.small,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
    minHeight: spacing.touch,
    paddingHorizontal: spacing.section,
  },
  rowLabel: {
    color: colors.text,
    flexShrink: 1,
    fontSize: typography.body,
  },
  rowStatus: {
    color: colors.faint,
    fontSize: typography.label,
    paddingLeft: spacing.compact,
  },
  note: {
    color: colors.faint,
    fontSize: typography.label,
    lineHeight: 18,
    paddingHorizontal: spacing.compact,
  },
});
