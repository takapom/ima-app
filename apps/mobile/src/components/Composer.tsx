import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radii, spacing, typography } from '../theme/tokens';

type ComposerProps = {
  readonly value: string;
  readonly placeholder: string;
  readonly suggestions: readonly string[];
  readonly onChange: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  readonly disabled?: boolean;
};

const appendSuggestion = (value: string, suggestion: string): string => {
  const current = value.trim();
  if (current.length === 0) return suggestion;
  if (current.includes(suggestion)) return current;
  return `${current}、${suggestion}`;
};

export function Composer({
  value,
  placeholder,
  suggestions,
  onChange,
  onSubmit,
  disabled = false,
}: ComposerProps): React.JSX.Element {
  const canSubmit = !disabled && onSubmit !== undefined && value.trim().length > 0;
  return (
    <View style={styles.container}>
      {suggestions.length > 0 ? (
        <View style={styles.suggestions}>
          {suggestions.map((suggestion) => (
            <Pressable
              accessibilityRole="button"
              key={suggestion}
              onPress={() => onChange(appendSuggestion(value, suggestion))}
              style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}
            >
              <Text style={styles.suggestionText}>＋{suggestion}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.inputRow}>
        <TextInput
          accessibilityLabel="検索条件"
          editable={!disabled}
          multiline
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          returnKeyType="default"
          style={styles.input}
          value={value}
        />
        <Pressable
          accessibilityLabel="検索を送信"
          accessibilityRole="button"
          disabled={!canSubmit}
          onPress={() => onSubmit?.(value)}
          style={({ pressed }) => [
            styles.send,
            !canSubmit && styles.sendDisabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.sendText}>↑</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.page,
    paddingBottom: spacing.section,
    paddingTop: spacing.compact,
  },
  suggestions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingBottom: spacing.compact,
  },
  suggestion: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.borderSoft,
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  suggestionText: {
    color: colors.text,
    fontSize: typography.label,
  },
  inputRow: {
    alignItems: 'flex-end',
    backgroundColor: 'rgba(18, 18, 20, 0.92)',
    borderColor: colors.border,
    borderRadius: radii.field,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.compact,
    paddingBottom: 6,
    paddingLeft: spacing.section,
    paddingRight: 6,
    paddingTop: 6,
  },
  input: {
    color: colors.text,
    flex: 1,
    fontSize: typography.body,
    lineHeight: 21,
    maxHeight: 96,
    minHeight: 36,
    paddingHorizontal: 0,
    paddingVertical: 7,
  },
  send: {
    alignItems: 'center',
    backgroundColor: colors.cream,
    borderRadius: radii.small,
    height: spacing.touch,
    justifyContent: 'center',
    width: spacing.touch,
  },
  sendDisabled: {
    opacity: 0.45,
  },
  sendText: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 22,
  },
  pressed: {
    opacity: 0.72,
  },
});
