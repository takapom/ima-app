import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  MAX_CHIPS,
  MAX_QUERY_LENGTH,
  appendSuggestion,
  uniqueTerms,
} from '@mobile/journey/state/journey-input';
import { paddingWithSafeArea } from '@mobile/ui/theme/safe-area';
import { colors, radii, scaleForDynamicType, spacing, typography } from '@mobile/ui/theme/tokens';
import { Icon } from '@mobile/ui/Icon';

type ComposerProps = {
  readonly value: string;
  readonly placeholder: string;
  readonly suggestions: readonly string[];
  readonly onChange: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  readonly onCancel?: () => void;
  readonly disabled?: boolean;
  readonly pending?: boolean;
  readonly maxLength?: number;
};

export function Composer({
  value,
  placeholder,
  suggestions,
  onChange,
  onSubmit,
  onCancel,
  disabled = false,
  pending = false,
  maxLength = MAX_QUERY_LENGTH,
}: ComposerProps): React.JSX.Element {
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const visibleSuggestions = uniqueTerms(suggestions, MAX_CHIPS);
  const canSubmit =
    !disabled &&
    !pending &&
    onSubmit !== undefined &&
    value.trim().length > 0 &&
    value.length <= maxLength;
  const canCancel = pending && onCancel !== undefined;
  const actionEnabled = pending ? canCancel : canSubmit;
  return (
    <View
      style={[
        styles.container,
        { paddingBottom: Math.max(18, paddingWithSafeArea(spacing.section, insets.bottom)) },
      ]}
    >
      {visibleSuggestions.length > 0 ? (
        <View style={styles.suggestions}>
          {visibleSuggestions.map((suggestion) => (
            <Pressable
              accessibilityRole="button"
              disabled={disabled || pending}
              key={suggestion}
              onPress={() => onChange(appendSuggestion(value, suggestion, maxLength))}
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
          editable={!disabled && !pending}
          multiline
          maxLength={maxLength}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          returnKeyType="default"
          style={[styles.input, { maxHeight: scaleForDynamicType(96, fontScale) }]}
          value={value}
        />
        {value.length >= maxLength * 0.9 ? (
          <Text accessibilityLabel={`${value.length}文字`} style={styles.counter}>
            {value.length}/{maxLength}
          </Text>
        ) : null}
        <Pressable
          accessibilityLabel={pending ? '検索を取り消す' : '検索を送信'}
          accessibilityRole="button"
          accessibilityState={{ disabled: !actionEnabled }}
          disabled={!actionEnabled}
          onPress={() => (pending ? onCancel?.() : onSubmit?.(value))}
          style={({ pressed }) => [
            styles.send,
            !actionEnabled && styles.sendDisabled,
            pressed && styles.pressed,
          ]}
        >
          <Icon
            name={pending ? 'close' : 'arrow'}
            size={18}
            color={actionEnabled ? colors.ink : colors.muted}
          />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.page,
    paddingBottom: spacing.section,
    paddingTop: 0,
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
    backgroundColor: '#151517',
    borderRadius: radii.field,
    flexDirection: 'row',
    gap: spacing.compact,
    paddingBottom: 6,
    paddingLeft: 16,
    paddingRight: 8,
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
  counter: {
    color: colors.faint,
    fontSize: 10,
    marginBottom: 13,
  },
  send: {
    alignItems: 'center',
    backgroundColor: colors.cream,
    borderRadius: radii.pill,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  sendDisabled: {
    backgroundColor: '#26262a',
  },
  pressed: {
    opacity: 0.72,
  },
});
