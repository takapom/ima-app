import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@mobile/theme/tokens';

type WorkingStateProps = {
  readonly query: string;
};

export function WorkingState({ query }: WorkingStateProps): React.JSX.Element {
  return (
    <View style={styles.container}>
      {query.length > 0 ? <Text style={styles.bubble}>{query}</Text> : null}
      <View accessibilityLiveRegion="polite" style={styles.panel}>
        <View style={styles.heading}>
          <ActivityIndicator color={colors.lime} size="small" />
          <Text style={styles.title}>いま探しています</Text>
        </View>
        <Text style={styles.detail}>近くで今いける場所を確認しています。</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.section,
    paddingHorizontal: spacing.page,
    paddingTop: spacing.compact,
  },
  bubble: {
    alignSelf: 'flex-end',
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radii.card,
    color: colors.text,
    fontSize: 13,
    lineHeight: 21,
    maxWidth: '86%',
    paddingHorizontal: spacing.section,
    paddingVertical: 11,
  },
  panel: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.borderSoft,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: spacing.section,
  },
  heading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.compact,
  },
  title: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
  },
  detail: {
    color: colors.muted,
    fontSize: typography.label,
    marginTop: spacing.compact,
  },
});
