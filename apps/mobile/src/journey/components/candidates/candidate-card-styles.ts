import { StyleSheet } from 'react-native';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

export const CANDIDATE_THUMBNAIL_SIZE = 92;
const SAVE_ACTION_SIZE = 40;

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.card,
    padding: spacing.section,
    gap: spacing.section,
  },
  summary: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.section,
    minHeight: spacing.touch * 2,
  },
  thumbnail: {
    borderRadius: radii.small,
    height: CANDIDATE_THUMBNAIL_SIZE,
    overflow: 'hidden',
    width: CANDIDATE_THUMBNAIL_SIZE,
  },
  heading: { flex: 1, minWidth: 0, gap: 5 },
  title: { gap: 5 },
  titleBesideSave: {
    minHeight: SAVE_ACTION_SIZE,
    paddingRight: SAVE_ACTION_SIZE + spacing.compact,
  },
  category: { color: colors.muted, fontSize: typography.label },
  name: { color: colors.text, fontSize: typography.cardTitle, fontWeight: '700' },
  dimmedText: { color: colors.muted },
  diff: { color: colors.muted, fontSize: typography.label },
  meta: { color: colors.muted, fontSize: typography.label },
  closing: { color: colors.lime, fontWeight: '700' },
  factLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  actionStack: { gap: 2 },
  detailsAction: {
    alignItems: 'center',
    backgroundColor: colors.cream,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: spacing.compact,
    height: spacing.touch,
    justifyContent: 'center',
    paddingHorizontal: spacing.section,
  },
  detailsActionText: { color: colors.ink, fontSize: typography.button, fontWeight: '700' },
  mapAction: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: SAVE_ACTION_SIZE,
    paddingHorizontal: spacing.section,
  },
  mapActionText: {
    color: colors.text,
    fontSize: typography.label,
    textDecorationLine: 'underline',
  },
  saveAction: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: 1,
    height: SAVE_ACTION_SIZE,
    justifyContent: 'center',
    position: 'absolute',
    right: 0,
    top: 0,
    width: SAVE_ACTION_SIZE,
  },
  saveActionEmphasized: {
    backgroundColor: colors.cream,
    borderColor: colors.cream,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});
