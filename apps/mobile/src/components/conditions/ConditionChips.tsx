import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MAX_CHIPS, uniqueTerms } from '../../state/journey-input';
import { colors, radii, spacing, typography } from '../../theme/tokens';

type ConditionChipsProps = {
  readonly chips: readonly string[];
  readonly onRemove?: (label: string) => void;
};

export function ConditionChips({ chips, onRemove }: ConditionChipsProps): React.JSX.Element | null {
  const visibleChips = uniqueTerms(chips, MAX_CHIPS);
  if (visibleChips.length === 0) return null;

  return (
    <View accessibilityLabel="検索条件" style={styles.container}>
      {visibleChips.map((chip) => (
        <View key={chip} style={styles.chip}>
          <Text style={styles.label}>{chip}</Text>
          {onRemove ? (
            <Pressable
              accessibilityLabel={`${chip}を外す`}
              accessibilityRole="button"
              hitSlop={6}
              onPress={() => onRemove(chip)}
              style={styles.remove}
            >
              <Text allowFontScaling={false} style={styles.removeText}>
                ×
              </Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.compact,
    paddingHorizontal: spacing.page,
    paddingTop: spacing.compact,
  },
  chip: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    minHeight: 36,
    paddingLeft: spacing.section,
    paddingRight: 7,
  },
  label: {
    color: colors.text,
    fontSize: typography.label,
  },
  remove: {
    alignItems: 'center',
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  removeText: {
    color: colors.muted,
    fontSize: 17,
    lineHeight: 19,
  },
});
