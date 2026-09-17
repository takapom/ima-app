import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AttributionList } from '@mobile/components/candidates/CandidateCard';
import {
  savedPlacePreviewDisplayFor,
  savedPlacePreviewFailureTextFor,
} from '@mobile/presentation/saved-place-preview-view';
import type { SavedPlacePreviewState } from '@mobile/state/saved-place-preview';
import { colors, radii, spacing, typography } from '@mobile/theme/tokens';

type SavedPlacePreviewPanelProps = {
  readonly state: SavedPlacePreviewState;
  readonly onClose: () => void;
  readonly onRetry: () => void;
  readonly onConsult: (savedPlaceRef: string) => void;
  readonly onSourcePress?: (sourceLink: string) => void;
  readonly consultDisabled?: boolean;
};

export function SavedPlacePreviewPanel({
  state,
  onClose,
  onRetry,
  onConsult,
  onSourcePress,
  consultDisabled = false,
}: SavedPlacePreviewPanelProps): React.JSX.Element | null {
  const selected = state.selected;
  if (selected === null) return null;

  const display = savedPlacePreviewDisplayFor(state);
  const title = display?.name ?? (state.status === 'ready' ? '店の情報を確認' : selected.name);
  const area = display?.area ?? (state.status === 'ready' ? null : selected.area);
  return (
    <View accessibilityLabel="保存店の詳細" style={styles.container}>
      <View style={styles.header}>
        <View style={styles.heading}>
          <Text style={styles.kicker}>保存店の詳細</Text>
          <Text style={styles.title}>{title}</Text>
          {area ? <Text style={styles.area}>{area}</Text> : null}
          {display !== null ? (
            <AttributionList
              attributions={display.attributions}
              {...(onSourcePress === undefined ? {} : { onSourcePress })}
            />
          ) : null}
        </View>
        <Pressable
          accessibilityLabel="保存店の詳細を閉じる"
          accessibilityRole="button"
          hitSlop={8}
          onPress={onClose}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
        >
          <Text style={styles.closeText}>×</Text>
        </Pressable>
      </View>
      {state.status === 'loading' ? (
        <Text style={styles.message}>詳細を取得しています。</Text>
      ) : null}
      {state.status === 'failed' ? (
        <View style={styles.failure}>
          <Text style={styles.message}>{savedPlacePreviewFailureTextFor(state.failure)}</Text>
          <Pressable
            accessibilityLabel="保存店の詳細を再試行"
            accessibilityRole="button"
            onPress={onRetry}
            style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
          >
            <Text style={styles.retryText}>再試行</Text>
          </Pressable>
        </View>
      ) : null}
      {state.status === 'ready' && display !== null ? (
        <Pressable
          accessibilityLabel="この店で相談"
          accessibilityRole="button"
          disabled={consultDisabled}
          onPress={() => onConsult(selected.serverSavedPlaceRef)}
          style={({ pressed }) => [styles.consult, pressed && styles.pressed]}
        >
          <Text style={styles.consultText}>この店で相談</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  area: {
    color: colors.muted,
    fontSize: typography.label,
    marginTop: 3,
  },
  close: {
    alignItems: 'center',
    height: spacing.touch,
    justifyContent: 'center',
    width: spacing.touch,
  },
  closeText: {
    color: colors.muted,
    fontSize: 24,
    lineHeight: 26,
  },
  consult: {
    alignItems: 'center',
    backgroundColor: colors.cream,
    borderRadius: radii.button,
    justifyContent: 'center',
    marginTop: spacing.section,
    minHeight: spacing.touch,
  },
  consultText: {
    color: colors.ink,
    fontSize: typography.button,
    fontWeight: '700',
  },
  container: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.card,
    marginHorizontal: spacing.page,
    marginTop: spacing.section,
    padding: spacing.section,
  },
  failure: {
    marginTop: spacing.compact,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  heading: {
    flex: 1,
  },
  kicker: {
    color: colors.lime,
    fontSize: typography.label,
    fontWeight: '700',
  },
  message: {
    color: colors.muted,
    fontSize: typography.label,
    lineHeight: 19,
    marginTop: spacing.compact,
  },
  pressed: {
    opacity: 0.72,
  },
  retry: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.button,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: spacing.compact,
    minHeight: spacing.touch,
  },
  retryText: {
    color: colors.text,
    fontSize: typography.button,
    fontWeight: '700',
  },
  title: {
    color: colors.text,
    fontSize: typography.title,
    fontWeight: '800',
    marginTop: spacing.compact,
  },
});
