import { useEffect } from 'react';
import { BackHandler, Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PublicCard } from '@ima/contracts';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import type { useCandidateDetail } from '@mobile/journey/hooks/useCandidateDetail';
import {
  candidateDetailPhotos,
  detailActions,
  detailSections,
  toCandidateDetailViewModel,
} from '@mobile/journey/presentation/candidate-detail-view';
import { PhotoRegion } from '@mobile/journey/components/candidates/PhotoRegion';
import { StatusPill } from '@mobile/journey/components/candidates/CandidateCardParts';
import { AttributionList } from '@mobile/ui/AttributionList';
import { Icon } from '@mobile/ui/Icon';
import { paddingWithSafeArea } from '@mobile/ui/theme/safe-area';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

type CandidateDetailSheetProps = {
  readonly detail: ReturnType<typeof useCandidateDetail>;
  readonly onDecide: (candidateId: string) => void;
  readonly onSave: (card: PublicCard) => void;
  readonly onSourcePress: (sourceLink: string) => void;
  readonly photoClient?: JourneyPhotoClient | undefined;
};

export function CandidateDetailSheet({
  detail,
  onDecide,
  onSave,
  onSourcePress,
  photoClient,
}: CandidateDetailSheetProps): React.JSX.Element | null {
  const insets = useSafeAreaInsets();
  const { card, close } = detail;
  useEffect(() => {
    if (card === null) return undefined;
    Keyboard.dismiss();
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => subscription.remove();
  }, [card, close]);
  if (card === null) return null;
  const view = toCandidateDetailViewModel(card, detail.now);
  const photos = candidateDetailPhotos(card, detail.photos, photoClient, detail.now);
  const handlers = { decide: () => onDecide(card.candidateId), save: () => onSave(card) };
  return (
    <>
      <Pressable
        accessibilityLabel="店舗詳細を閉じる"
        accessibilityRole="button"
        onPress={close}
        style={styles.scrim}
      />
      <View
        accessibilityViewIsModal
        onAccessibilityEscape={close}
        style={[
          styles.sheet,
          {
            top: paddingWithSafeArea(spacing.compact, insets.top),
            paddingBottom: paddingWithSafeArea(spacing.page, insets.bottom),
          },
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.label}>店舗詳細</Text>
          <Pressable
            accessibilityLabel="店舗詳細を閉じる"
            accessibilityRole="button"
            onPress={close}
            style={styles.close}
          >
            <Icon name="close" color={colors.muted} />
          </Pressable>
        </View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          {photos.length === 0 ? null : (
            <View style={styles.photo}>
              <PhotoRegion card={card} images={photos} />
            </View>
          )}
          <View style={[styles.heading, view.dimmed && styles.dimmed]}>
            {view.category === null ? null : <Text style={styles.label}>{view.category}</Text>}
            <Text accessibilityRole="header" style={styles.name}>
              {view.name}
            </Text>
            <StatusPill opening={view.opening} />
          </View>
          {detailSections(view).map(({ label, lines }) => (
            <View key={label} style={styles.section}>
              <Text style={styles.label}>{label}</Text>
              {lines.map((line, index) => (
                <Text key={index} style={styles.value}>
                  {line}
                </Text>
              ))}
            </View>
          ))}
          <View style={styles.section}>
            <Text style={styles.label}>出典</Text>
            <AttributionList
              attributions={view.attributions}
              comfortable
              onSourcePress={(url) => {
                close();
                onSourcePress(url);
              }}
            />
          </View>
        </ScrollView>
        <View style={styles.actions}>
          {detailActions(view).map((action, index) => (
            <Pressable
              key={action.kind}
              accessibilityRole="button"
              onPress={() => {
                close();
                handlers[action.kind]();
              }}
              style={({ pressed }) => [
                styles.action,
                index === 0 ? styles.primary : styles.secondary,
                pressed && styles.dimmed,
              ]}
            >
              <Text style={index === 0 ? styles.primaryText : styles.secondaryText}>
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlayScrim, zIndex: 6 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 7,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.canvas,
    borderTopRightRadius: radii.canvas,
    paddingHorizontal: spacing.page,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: {
    minWidth: spacing.touch,
    minHeight: spacing.touch,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: { flex: 1 },
  content: { gap: spacing.canvas, paddingBottom: spacing.canvas },
  photo: { aspectRatio: 1, overflow: 'hidden', borderRadius: radii.card },
  heading: { gap: spacing.compact, alignItems: 'flex-start' },
  name: { color: colors.text, fontSize: typography.title, fontWeight: '800' },
  label: { color: colors.muted, fontSize: typography.label },
  section: { gap: spacing.compact },
  value: {
    color: colors.text,
    fontSize: typography.body,
    lineHeight: typography.body + spacing.compact,
  },
  actions: { flexDirection: 'row', gap: spacing.compact, paddingTop: spacing.section },
  action: {
    flex: 1,
    minHeight: spacing.touch,
    padding: spacing.section,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
  },
  primary: { backgroundColor: colors.cream },
  secondary: { borderColor: colors.border, borderWidth: 1 },
  primaryText: { color: colors.ink, fontSize: typography.button, fontWeight: '700' },
  secondaryText: { color: colors.text, fontSize: typography.button, fontWeight: '700' },
  dimmed: { opacity: 0.6 },
});
