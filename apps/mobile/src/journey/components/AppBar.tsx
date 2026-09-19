import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { paddingWithSafeArea } from '@mobile/ui/theme/safe-area';
import { colors, spacing } from '@mobile/ui/theme/tokens';
import { Icon } from '@mobile/ui/Icon';

type AppBarProps = {
  readonly onMenu: () => void;
  readonly onNewSearch: () => void;
};

export function AppBar({ onMenu, onNewSearch }: AppBarProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.container,
        { paddingTop: Math.max(20, paddingWithSafeArea(spacing.compact, insets.top)) },
      ]}
    >
      <Pressable
        accessibilityLabel="メニュー"
        accessibilityRole="button"
        hitSlop={8}
        onPress={onMenu}
        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
      >
        <Icon name="menu" size={16} color="#7c7b76" />
      </Pressable>
      <Text style={styles.logo} accessibilityRole="header">
        ima<Text style={styles.logoDot}>.</Text>
      </Text>
      <Pressable
        accessibilityLabel="新しい検索"
        accessibilityRole="button"
        hitSlop={8}
        onPress={onNewSearch}
        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
      >
        <Icon name="plus" size={16} color="#7c7b76" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.page,
    paddingBottom: 4,
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: '#151517',
    borderRadius: 999,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  logo: {
    color: '#8f8e88',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  logoDot: {
    color: colors.lime,
  },
  pressed: {
    opacity: 0.72,
  },
});
