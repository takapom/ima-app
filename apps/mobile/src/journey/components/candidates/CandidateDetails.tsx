import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PublicCard } from '@ima/contracts';
import type { CardViewModel } from '@mobile/journey/presentation/candidate-card-view';
import { candidateDetails } from '@mobile/journey/presentation/candidate-details';
import { cardAttributions } from '@mobile/journey/presentation/card-attributions';
import { presentEvidenceText } from '@mobile/journey/components/candidates/candidate-card-model';
import { AttributionList } from '@mobile/ui/AttributionList';
import { Icon } from '@mobile/ui/Icon';
import { colors } from '@mobile/ui/theme/tokens';

type CandidateDetailsProps = {
  readonly card: PublicCard;
  readonly view: CardViewModel;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onDecide?: (candidateId: string) => void;
  readonly onSave?: (card: PublicCard) => void;
  readonly onSkip?: (candidateId: string) => void;
  readonly onSourcePress?: (sourceLink: string) => void;
};

export function CandidateDetails({
  card,
  view,
  visible,
  onClose,
  onDecide,
  onSave,
  onSkip,
  onSourcePress,
}: CandidateDetailsProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const details = candidateDetails(card);
  const why = presentEvidenceText(card.why);
  const saveFirst = view.primaryAction === 'save';
  const openSource =
    onSourcePress === undefined
      ? undefined
      : (url: string): void => {
          onClose();
          onSourcePress(url);
        };
  const decide =
    onDecide === undefined
      ? undefined
      : () => {
          onClose();
          onDecide(card.candidateId);
        };
  const save =
    onSave === undefined
      ? undefined
      : () => {
          onClose();
          onSave(card);
        };
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={[styles.overlay, { paddingTop: insets.top + 16 }]}>
        <Pressable
          accessibilityLabel="店舗詳細を閉じる"
          accessibilityRole="button"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          style={[styles.sheet, { paddingBottom: Math.max(18, insets.bottom) }]}
        >
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>
              {view.name}
            </Text>
            <Pressable
              accessibilityLabel="店舗詳細を閉じる"
              accessibilityRole="button"
              onPress={onClose}
              style={styles.close}
            >
              <Icon name="close" color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <Text style={styles.why}>{why.text}</Text>
            {details.rows.map(({ label, fact }) => (
              <View key={label} style={styles.fact}>
                <Text style={styles.label}>{label}</Text>
                <Text style={styles.value}>{fact.label}</Text>
              </View>
            ))}
            {details.sourceUrl !== null && openSource !== undefined ? (
              <Pressable
                accessibilityRole="link"
                onPress={() => {
                  if (details.sourceUrl !== null) openSource(details.sourceUrl);
                }}
                style={styles.source}
              >
                <Text style={styles.link}>掲載元で詳細を見る</Text>
                <Icon name="chevron" size={12} color={colors.muted} />
              </Pressable>
            ) : null}
            <AttributionList
              attributions={cardAttributions(card)}
              {...(openSource === undefined ? {} : { onSourcePress: openSource })}
            />
          </ScrollView>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={(saveFirst ? save : decide) === undefined}
              accessibilityState={{ disabled: (saveFirst ? save : decide) === undefined }}
              onPress={saveFirst ? save : decide}
              style={({ pressed }) => [
                styles.primary,
                ((saveFirst ? save : decide) === undefined || pressed) && styles.dimmed,
              ]}
            >
              <Text style={styles.primaryText}>
                {saveFirst ? '明日のために残す' : 'ここにする'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={(saveFirst ? decide : save) === undefined}
              accessibilityState={{ disabled: (saveFirst ? decide : save) === undefined }}
              onPress={saveFirst ? decide : save}
              style={({ pressed }) => [
                styles.secondary,
                ((saveFirst ? decide : save) === undefined || pressed) && styles.dimmed,
              ]}
            >
              <Text style={styles.secondaryText}>{saveFirst ? 'ここにする' : '残す'}</Text>
            </Pressable>
          </View>
          {onSkip === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onClose();
                onSkip(card.candidateId);
              }}
              style={styles.skip}
            >
              <Text style={styles.link}>今夜の候補から外す</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.65)' },
  sheet: {
    maxHeight: '92%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 16,
    paddingBottom: 12,
  },
  title: { flex: 1, color: colors.text, fontSize: 22, fontWeight: '800', lineHeight: 30 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: { gap: 18, paddingBottom: 20 },
  why: { color: colors.text, fontSize: 14, lineHeight: 23 },
  fact: { gap: 5 },
  label: { color: colors.muted, fontSize: 12 },
  value: { color: colors.text, fontSize: 14, lineHeight: 23 },
  source: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  link: { color: colors.muted, fontSize: 13, textDecorationLine: 'underline' },
  actions: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  primary: {
    flex: 1,
    backgroundColor: colors.cream,
    borderRadius: 15,
    minHeight: 50,
    padding: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  secondary: {
    minWidth: 84,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 15,
    minHeight: 50,
    padding: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  skip: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  dimmed: { opacity: 0.5 },
});
