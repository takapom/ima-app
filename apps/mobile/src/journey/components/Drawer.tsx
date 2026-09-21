import {
  ConversationHistoryList,
  type ConversationNavigation,
} from '@mobile/journey/components/conversations/ConversationHistoryList';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConditionEditor } from '@mobile/preferences/components/ConditionEditor';
import { paddingWithSafeArea } from '@mobile/ui/theme/safe-area';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';
import type { ConditionScope, JourneyConditions } from '@mobile/preferences/state/conditions';
import type {
  DrawerView,
  SavedPlaceItem,
  SearchHistoryItem,
} from '@mobile/journey/state/journey-shell';

type DrawerProps = {
  readonly conversationNavigation?: ConversationNavigation;
  readonly open: boolean;
  readonly view: DrawerView;
  readonly history: readonly SearchHistoryItem[];
  readonly historyUnavailable?: boolean;
  readonly savedPlaces: readonly SavedPlaceItem[];
  readonly savedPlacesUnavailable?: boolean;
  readonly onClose: () => void;
  readonly onNewSearch: () => void;
  readonly onViewChange: (view: DrawerView) => void;
  readonly conditions: JourneyConditions;
  readonly savedConditions: JourneyConditions;
  readonly conditionScope: ConditionScope;
  readonly onConditionScopeChange: (scope: ConditionScope) => void;
  readonly onConditionsChange: (scope: ConditionScope, changes: Partial<JourneyConditions>) => void;
  readonly conditionNotice?: string | null;
  readonly onHistorySelect?: (item: SearchHistoryItem) => void;
  readonly onSavedPlaceSelect?: (item: SavedPlaceItem) => void;
};

const viewTitle: Record<DrawerView, string> = {
  home: '今夜',
  history: '今夜の履歴',
  saved: '保存した店',
  conditions: '条件',
};

export function Drawer({
  conversationNavigation,
  open,
  view,
  history,
  historyUnavailable = false,
  savedPlaces,
  savedPlacesUnavailable = false,
  onClose,
  onNewSearch,
  onViewChange,
  conditions,
  savedConditions,
  conditionScope,
  onConditionScopeChange,
  onConditionsChange,
  conditionNotice = null,
  onHistorySelect,
  onSavedPlaceSelect,
}: DrawerProps): React.JSX.Element | null {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  if (!open) return null;

  const drawerWidth = Math.min(width * 0.86, 320);
  const selectHistory = (item: SearchHistoryItem): void => {
    onHistorySelect?.(item);
    onClose();
  };
  const selectSavedPlace = (item: SavedPlaceItem): void => {
    onSavedPlaceSelect?.(item);
    onClose();
  };

  return (
    <>
      <Pressable accessibilityLabel="メニューを閉じる" onPress={onClose} style={styles.scrim} />
      <View
        accessibilityViewIsModal
        style={[
          styles.drawer,
          {
            paddingBottom: paddingWithSafeArea(spacing.section, insets.bottom),
            paddingTop: paddingWithSafeArea(spacing.section, insets.top),
            width: drawerWidth,
          },
        ]}
      >
        <View style={styles.header}>
          {view === 'home' ? (
            <Text style={styles.logo}>
              ima<Text style={styles.logoDot}>.</Text>
            </Text>
          ) : (
            <Pressable
              accessibilityLabel="メニューに戻る"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => onViewChange('home')}
              style={styles.backButton}
            >
              <Text allowFontScaling={false} style={styles.back}>
                ‹
              </Text>
              <Text style={styles.backLabel}>今夜</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityLabel="メニューを閉じる"
            accessibilityRole="button"
            hitSlop={8}
            onPress={onClose}
            style={styles.closeButton}
          >
            <Text allowFontScaling={false} style={styles.close}>
              ×
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollBody}
          keyboardShouldPersistTaps="handled"
          style={styles.scroll}
        >
          {view === 'home' ? (
            <HomeView
              onClose={onClose}
              {...(conversationNavigation === undefined ? {} : { conversationNavigation })}
              history={history}
              historyUnavailable={historyUnavailable}
              savedPlaces={savedPlaces}
              onConditions={() => onViewChange('conditions')}
              onNewSearch={onNewSearch}
              onViewChange={onViewChange}
            />
          ) : view === 'history' ? (
            conversationNavigation !== undefined ? (
              <ConversationHistoryList navigation={conversationNavigation} onClose={onClose} />
            ) : (
              <ListView
                emptyLabel={
                  historyUnavailable ? '履歴を利用できません' : 'まだ今夜の検索はありません'
                }
                items={history}
                renderItem={(item) => (
                  <Pressable
                    accessibilityRole="button"
                    key={item.id}
                    onPress={() => selectHistory(item)}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  >
                    <Text style={styles.rowTitle}>{item.label}</Text>
                    <Text numberOfLines={2} style={styles.rowMeta}>
                      {item.query}
                    </Text>
                    <Text style={styles.rowTime}>{item.time}</Text>
                  </Pressable>
                )}
                title={viewTitle[view]}
              />
            )
          ) : view === 'saved' ? (
            <ListView
              emptyLabel={
                savedPlacesUnavailable ? '保存した店を利用できません' : '保存した店はまだありません'
              }
              items={savedPlaces}
              renderItem={(item) => (
                <Pressable
                  accessibilityRole="button"
                  key={item.id}
                  onPress={() => selectSavedPlace(item)}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <Text style={styles.rowTitle}>{item.name}</Text>
                  <Text style={styles.rowMeta}>{item.area}</Text>
                </Pressable>
              )}
              title={viewTitle[view]}
            />
          ) : (
            <ConditionEditor
              conditions={conditionScope === 'thread' ? conditions : savedConditions}
              onChange={(changes) => onConditionsChange(conditionScope, changes)}
              onScopeChange={onConditionScopeChange}
              notice={conditionNotice}
              scope={conditionScope}
            />
          )}
        </ScrollView>
      </View>
    </>
  );
}

type HomeViewProps = {
  readonly conversationNavigation?: ConversationNavigation;
  readonly onClose: () => void;
  readonly history: readonly SearchHistoryItem[];
  readonly historyUnavailable: boolean;
  readonly savedPlaces: readonly SavedPlaceItem[];
  readonly onNewSearch: () => void;
  readonly onViewChange: (view: DrawerView) => void;
  readonly onConditions: () => void;
};

function HomeView({
  conversationNavigation,
  onClose,
  history,
  historyUnavailable,
  savedPlaces,
  onConditions,
  onNewSearch,
  onViewChange,
}: HomeViewProps): React.JSX.Element {
  return (
    <View style={styles.body}>
      <Pressable
        accessibilityRole="button"
        onPress={onNewSearch}
        style={({ pressed }) => [styles.newButton, pressed && styles.rowPressed]}
      >
        <Text style={styles.newButtonText}>
          {conversationNavigation === undefined ? '新しい検索' : '新しい会話'}
        </Text>
      </Pressable>
      {conversationNavigation !== undefined ? (
        <ConversationHistoryList navigation={conversationNavigation} onClose={onClose} />
      ) : (
        <>
          <Text style={styles.sectionLabel}>今夜の履歴</Text>
          {historyUnavailable ? (
            <Text style={styles.empty}>履歴を利用できません</Text>
          ) : history.length === 0 ? (
            <Text style={styles.empty}>まだ今夜の検索はありません</Text>
          ) : (
            history.slice(0, 4).map((item) => (
              <Text key={item.id} numberOfLines={1} style={styles.historyPreview}>
                {item.label}
              </Text>
            ))
          )}
        </>
      )}
      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          onPress={() => onViewChange('history')}
          style={({ pressed }) => [styles.navRow, pressed && styles.rowPressed]}
        >
          <Text style={styles.navText}>
            {conversationNavigation === undefined ? '今夜の履歴' : '会話履歴'}
          </Text>
          <Text style={styles.navCount}>
            {conversationNavigation?.conversations.length ?? history.length}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => onViewChange('saved')}
          style={({ pressed }) => [styles.navRow, pressed && styles.rowPressed]}
        >
          <Text style={styles.navText}>保存した店</Text>
          <Text style={styles.navCount}>{savedPlaces.length}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onConditions}
          style={({ pressed }) => [styles.navRow, pressed && styles.rowPressed]}
        >
          <Text style={styles.navText}>条件</Text>
        </Pressable>
      </View>
    </View>
  );
}

type ListViewProps<T extends { readonly id: string }> = {
  readonly title: string;
  readonly emptyLabel: string;
  readonly items: readonly T[];
  readonly renderItem: (item: T) => React.JSX.Element;
};

function ListView<T extends { readonly id: string }>({
  title,
  emptyLabel,
  items,
  renderItem,
}: ListViewProps<T>): React.JSX.Element {
  return (
    <View style={styles.body}>
      <Text style={styles.sectionLabel}>{title}</Text>
      {items.length === 0 ? <Text style={styles.empty}>{emptyLabel}</Text> : items.map(renderItem)}
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    backgroundColor: 'rgba(0, 0, 0, 0.46)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 8,
  },
  drawer: {
    backgroundColor: '#0a0a0b',
    borderRightColor: '#1c1c1c',
    borderRightWidth: 1,
    bottom: 0,
    elevation: 8,
    left: 0,
    paddingHorizontal: spacing.section,
    paddingTop: spacing.section,
    position: 'absolute',
    shadowColor: '#000',
    shadowOffset: { height: 0, width: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    top: 0,
    zIndex: 9,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 40,
    paddingHorizontal: spacing.compact,
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
  closeButton: {
    alignItems: 'center',
    height: spacing.touch,
    justifyContent: 'center',
    width: spacing.touch,
  },
  close: {
    color: colors.muted,
    fontSize: 27,
    lineHeight: 29,
  },
  backButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    height: 40,
  },
  back: {
    color: colors.muted,
    fontSize: 30,
    lineHeight: 30,
  },
  backLabel: {
    color: colors.muted,
    fontSize: typography.label,
    fontWeight: '700',
  },
  body: {
    flex: 1,
    paddingTop: spacing.section,
  },
  scrollBody: {
    flexGrow: 1,
  },
  scroll: {
    flex: 1,
  },
  newButton: {
    alignItems: 'center',
    backgroundColor: colors.cream,
    borderRadius: radii.button,
    justifyContent: 'center',
    marginBottom: spacing.section,
    minHeight: spacing.touch,
    paddingHorizontal: spacing.section,
  },
  newButtonText: {
    color: colors.ink,
    fontSize: typography.button,
    fontWeight: '700',
  },
  sectionLabel: {
    color: colors.faint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    paddingHorizontal: spacing.compact,
    paddingVertical: spacing.compact,
  },
  empty: {
    color: colors.faint,
    fontSize: typography.label,
    lineHeight: 20,
    paddingHorizontal: spacing.compact,
    paddingVertical: spacing.compact,
  },
  historyPreview: {
    color: colors.text,
    fontSize: typography.label,
    paddingHorizontal: spacing.compact,
    paddingVertical: 7,
  },
  footer: {
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    gap: 2,
    marginTop: 'auto',
    paddingTop: spacing.compact,
  },
  navRow: {
    alignItems: 'center',
    borderRadius: radii.small,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: spacing.touch,
    paddingHorizontal: spacing.compact,
  },
  navText: {
    color: colors.text,
    fontSize: typography.body,
  },
  navCount: {
    color: colors.faint,
    fontSize: typography.label,
  },
  row: {
    borderRadius: radii.small,
    marginBottom: 4,
    paddingHorizontal: spacing.compact,
    paddingVertical: spacing.section,
  },
  rowPressed: {
    backgroundColor: colors.surface,
    opacity: 0.86,
  },
  rowTitle: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
  },
  rowMeta: {
    color: colors.muted,
    fontSize: typography.label,
    lineHeight: 18,
    marginTop: 2,
  },
  rowTime: {
    color: colors.faint,
    fontSize: 11,
    marginTop: 4,
  },
});
