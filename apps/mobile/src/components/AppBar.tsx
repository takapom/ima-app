import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../theme/tokens';

type AppBarProps = {
  readonly onMenu: () => void;
  readonly onNewSearch: () => void;
};

export function AppBar({ onMenu, onNewSearch }: AppBarProps): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityLabel="メニュー"
        accessibilityRole="button"
        hitSlop={8}
        onPress={onMenu}
        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
      >
        <Text allowFontScaling={false} style={styles.icon}>
          ☰
        </Text>
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
        <Text allowFontScaling={false} style={styles.plus}>
          ＋
        </Text>
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
    paddingVertical: spacing.compact,
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.borderSoft,
    borderRadius: radii.small,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  icon: {
    color: colors.text,
    fontSize: 19,
    lineHeight: 21,
  },
  plus: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '300',
    lineHeight: 25,
  },
  logo: {
    color: colors.text,
    fontSize: typography.title,
    fontWeight: '800',
    letterSpacing: -1,
  },
  logoDot: {
    color: colors.lime,
  },
  pressed: {
    opacity: 0.72,
  },
});
