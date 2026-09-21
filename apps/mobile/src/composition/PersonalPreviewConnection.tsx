import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { personalPreviewConfiguration } from '@mobile/composition/personal-preview';
import type { NativeMobileRuntimeOptions } from '@mobile/composition/native-mobile-runtime';
import {
  createPersonalConnection,
  type PersonalConnectionResult,
} from '@mobile/platform/credentials/personal-connection';
import { PersonalConnectionScreen } from '@mobile/composition/PersonalConnectionScreen';
import { colors, spacing, typography } from '@mobile/ui/theme/tokens';
import { paddingWithSafeArea } from '@mobile/ui/theme/safe-area';

type Props = {
  readonly bypass: boolean;
  readonly children: (options: NativeMobileRuntimeOptions | undefined) => React.ReactNode;
};

const messageFor = (result: PersonalConnectionResult | null): string | null => {
  switch (result?.status) {
    case 'invalid_token':
      return 'APP_TOKENは64文字の半角英数字（0〜9、a〜f）で入力してください。';
    case 'invalid':
      return '接続設定を読み込めません。アプリの設定を確認してください。';
    case 'unavailable':
      return '端末への安全な保存ができません。ロックを解除して、もう一度お試しください。';
    case undefined:
    case 'ready':
    case 'missing':
      return null;
  }
};

/** Personal builds provision the existing native credential boundary once. */
export function PersonalPreviewConnection({ bypass, children }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const configuration = useMemo(
    () =>
      personalPreviewConfiguration(
        {
          EXPO_PUBLIC_PERSONAL_PREVIEW: process.env.EXPO_PUBLIC_PERSONAL_PREVIEW,
          EXPO_PUBLIC_ENVIRONMENT: process.env.EXPO_PUBLIC_ENVIRONMENT,
          EXPO_PUBLIC_API_MODE: process.env.EXPO_PUBLIC_API_MODE,
          EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
        },
        Platform.OS,
      ),
    [],
  );
  const service = useMemo(
    () =>
      configuration.kind === 'enabled' ? createPersonalConnection(configuration.target) : null,
    [configuration],
  );
  const [connection, setConnection] = useState<PersonalConnectionResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const options = useMemo<NativeMobileRuntimeOptions | undefined>(
    () => (connection?.status === 'ready' ? { nativeAuthority: connection.authority } : undefined),
    [connection],
  );

  useEffect(() => {
    if (bypass || service === null) return;
    let active = true;
    void service.load().then(
      (result) => {
        if (active) setConnection(result);
      },
      () => {
        if (active) setConnection({ status: 'unavailable' });
      },
    );
    return () => {
      active = false;
    };
  }, [bypass, service]);

  if (bypass || configuration.kind === 'disabled') return <>{children(undefined)}</>;
  if (connection?.status === 'ready' && !editing) {
    return (
      <View style={styles.root}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="接続設定を変更"
          onPress={() => setEditing(true)}
          style={[
            styles.settings,
            { paddingTop: paddingWithSafeArea(spacing.compact, insets.top) },
          ]}
        >
          <Text style={styles.label}>接続設定</Text>
        </Pressable>
        {children(options)}
      </View>
    );
  }
  const save = async (token: string): Promise<void> => {
    if (service === null || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const result = await service.save(token);
    setConnection(result);
    setSaving(false);
    savingRef.current = false;
    if (result.status === 'ready') setEditing(false);
  };
  return (
    <PersonalConnectionScreen
      pending={saving || (configuration.kind === 'enabled' && connection === null)}
      error={
        configuration.kind === 'invalid'
          ? '個人検証用の接続先設定が正しくありません。'
          : messageFor(connection)
      }
      endpoint={configuration.kind === 'enabled' ? configuration.target.apiBaseUrl : ''}
      enabled={service !== null}
      onSave={(token) => {
        void save(token).catch(() => {
          setConnection({ status: 'unavailable' });
          setSaving(false);
          savingRef.current = false;
        });
      }}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  settings: {
    minHeight: spacing.touch,
    paddingHorizontal: spacing.page,
    paddingBottom: spacing.compact,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  label: { color: colors.muted, fontSize: typography.label },
});
