import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '../../theme/tokens';

type EmptyStateProps = {
  readonly onExample: (query: string) => void;
};

/** Walking and last-train conditions are omitted until those providers are connected. */
const EXAMPLES = [
  '恵比寿、ご飯終わり。静かめで甘いもの。',
  '雨だから屋内。まだ話していたい。高すぎない二軒目。',
  '少し疲れた。座れるところ。甘いものはもういらない。',
] as const;

export function EmptyState({ onExample }: EmptyStateProps): React.JSX.Element {
  return (
    <View style={styles.container}>
      <View>
        <Text style={styles.title}>
          次どこ{`\n`}行く<Text style={styles.question}>?</Text>
        </Text>
        <Text style={styles.lead}>いまの状況、そのまま書いて。近くで今いけるとこ出す。</Text>
      </View>
      <View style={styles.examples}>
        {EXAMPLES.map((example) => (
          <Pressable
            accessibilityRole="button"
            key={example}
            onPress={() => onExample(example)}
            style={({ pressed }) => [styles.example, pressed && styles.pressed]}
          >
            <Text style={styles.exampleText}>{example}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.canvas,
    paddingVertical: spacing.compact,
    gap: spacing.section,
  },
  title: {
    color: colors.text,
    fontSize: typography.display,
    fontWeight: '800',
    letterSpacing: -1.4,
    lineHeight: 40,
  },
  question: {
    color: colors.lime,
  },
  lead: {
    color: colors.muted,
    fontSize: typography.body,
    fontWeight: '500',
    lineHeight: 23,
    marginTop: spacing.section,
  },
  examples: {
    gap: spacing.compact,
  },
  example: {
    backgroundColor: '#101010',
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: spacing.section,
    paddingVertical: spacing.section,
  },
  exampleText: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 21,
  },
  pressed: {
    backgroundColor: colors.surface,
  },
});
