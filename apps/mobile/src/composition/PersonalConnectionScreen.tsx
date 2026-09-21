import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';
import { paddingWithSafeArea } from '@mobile/ui/theme/safe-area';

type Props = {
  readonly pending: boolean;
  readonly enabled: boolean;
  readonly error: string | null;
  readonly endpoint: string;
  readonly onSave: (token: string) => void;
};

export function PersonalConnectionScreen({
  pending,
  enabled,
  error,
  endpoint,
  onSave,
}: Props): React.JSX.Element {
  const [token, setToken] = useState('');
  const insets = useSafeAreaInsets();
  const disabled = pending || !enabled || token.trim().length === 0;
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.root}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.body,
          {
            paddingTop: paddingWithSafeArea(spacing.canvas, insets.top),
            paddingBottom: paddingWithSafeArea(spacing.canvas, insets.bottom),
          },
        ]}
      >
        <Text style={styles.title}>検証用の接続設定</Text>
        <Text style={styles.text}>
          Cloudflareに登録したAPP_TOKENを入力してください。端末内に安全に保存します。
        </Text>
        <Text selectable style={styles.endpoint}>
          {endpoint}
        </Text>
        <TextInput
          accessibilityLabel="APP_TOKEN"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          textContentType="none"
          value={token}
          onChangeText={setToken}
          editable={!pending && enabled}
          placeholder="APP_TOKEN"
          placeholderTextColor={colors.muted}
          style={styles.input}
          returnKeyType="done"
          onSubmitEditing={() => {
            if (!disabled) onSave(token.trim());
          }}
        />
        {error === null ? null : (
          <Text accessibilityRole="alert" style={styles.text}>
            {error}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled, busy: pending }}
          disabled={disabled}
          onPress={() => onSave(token.trim())}
          style={[styles.button, disabled && styles.disabled]}
        >
          <Text style={styles.buttonText}>
            {pending ? '接続を準備しています…' : '保存してはじめる'}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: spacing.section,
    paddingHorizontal: spacing.canvas,
  },
  title: { color: colors.text, fontSize: typography.title, fontWeight: '700' },
  text: { color: colors.text, fontSize: typography.body },
  endpoint: { color: colors.muted, fontSize: typography.label },
  input: {
    minHeight: spacing.touch,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.field,
    paddingHorizontal: spacing.page,
    color: colors.text,
    fontSize: typography.body,
  },
  button: {
    minHeight: spacing.touch,
    borderRadius: radii.button,
    backgroundColor: colors.lime,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: colors.ink, fontSize: typography.button, fontWeight: '700' },
  disabled: { backgroundColor: colors.muted },
});
