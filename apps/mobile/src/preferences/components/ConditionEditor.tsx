import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  budgetLabel,
  type BudgetOption,
  type ConditionScope,
  type JourneyConditions,
} from '@mobile/preferences/state/conditions';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

type ConditionEditorProps = {
  readonly conditions: JourneyConditions;
  readonly scope: ConditionScope;
  readonly onScopeChange: (scope: ConditionScope) => void;
  readonly onChange: (changes: Partial<JourneyConditions>) => void;
  readonly notice?: string | null;
};

const budgetOptions: readonly BudgetOption[] = ['cheap', 'normal', 'any'];

const nextValue = <T,>(values: readonly T[], current: T): T => {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length] as T;
};

export function ConditionEditor({
  conditions,
  scope,
  onScopeChange,
  onChange,
  notice = null,
}: ConditionEditorProps): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>条件</Text>
      <Text style={styles.description}>
        この検索だけの条件と、次回も使う設定を分けて編集できます。徒歩時間と終電は扱っていません。
      </Text>
      {scope === 'saved' && notice !== null ? <Text style={styles.notice}>{notice}</Text> : null}
      <View accessibilityRole="tablist" style={styles.scopeTabs}>
        <ScopeTab
          label="この検索"
          selected={scope === 'thread'}
          onPress={() => onScopeChange('thread')}
        />
        <ScopeTab
          label="保存設定"
          selected={scope === 'saved'}
          onPress={() => onScopeChange('saved')}
        />
      </View>

      <ConditionRow label="予算">
        <Pressable
          accessibilityLabel="予算を変更"
          accessibilityRole="button"
          onPress={() => onChange({ budget: nextValue(budgetOptions, conditions.budget) })}
          style={({ pressed }) => [styles.valueButton, pressed && styles.pressed]}
        >
          <Text style={styles.valueText}>{budgetLabel(conditions.budget)}</Text>
        </Pressable>
      </ConditionRow>
    </View>
  );
}

type ScopeTabProps = {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
};

function ScopeTab({ label, selected, onPress }: ScopeTabProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.scopeTab,
        selected && styles.scopeTabSelected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.scopeText, selected && styles.scopeTextSelected]}>{label}</Text>
    </Pressable>
  );
}

type ConditionRowProps = {
  readonly label: string;
  readonly children: React.ReactNode;
};

function ConditionRow({ label, children }: ConditionRowProps): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValue}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.section,
    padding: spacing.section,
  },
  title: {
    color: colors.text,
    fontSize: typography.title,
    fontWeight: '800',
  },
  description: {
    color: colors.muted,
    fontSize: typography.label,
    lineHeight: 20,
  },
  scopeTabs: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.small,
    flexDirection: 'row',
    gap: 4,
    padding: 4,
  },
  scopeTab: {
    alignItems: 'center',
    borderRadius: radii.small,
    flex: 1,
    justifyContent: 'center',
    minHeight: spacing.touch,
    paddingHorizontal: spacing.compact,
  },
  scopeTabSelected: {
    backgroundColor: colors.surfaceRaised,
  },
  scopeText: {
    color: colors.muted,
    fontSize: typography.label,
    fontWeight: '700',
  },
  scopeTextSelected: {
    color: colors.text,
  },
  row: {
    alignItems: 'center',
    borderBottomColor: colors.borderSoft,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.section,
    minHeight: spacing.touch,
    paddingVertical: spacing.compact,
  },
  rowLabel: {
    color: colors.muted,
    fontSize: typography.body,
    width: 64,
  },
  rowValue: {
    alignItems: 'flex-end',
    flex: 1,
  },
  notice: {
    color: colors.cream,
    fontSize: typography.label,
    lineHeight: 20,
  },
  valueButton: {
    borderColor: colors.border,
    borderRadius: radii.small,
    borderWidth: 1,
    minHeight: spacing.touch,
    justifyContent: 'center',
    paddingHorizontal: spacing.section,
  },
  valueText: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.72,
  },
});
