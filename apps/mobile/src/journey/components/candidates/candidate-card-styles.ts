import { StyleSheet } from 'react-native';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

export const CANDIDATE_THUMBNAIL_SIZE = 92;
const ICON_ACTION_SIZE = 40;
const FACT_LINE_HEIGHT = 16;

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
  category: { color: colors.muted, fontSize: typography.label },
  name: { color: colors.text, fontSize: typography.cardTitle, fontWeight: '700' },
  dimmedText: { color: colors.muted },
  diff: { color: colors.muted, fontSize: typography.label },
  meta: {
    color: colors.muted,
    flexShrink: 1,
    fontSize: typography.label,
    lineHeight: FACT_LINE_HEIGHT,
  },
  closing: { color: colors.lime, fontWeight: '700' },
  factLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    minWidth: 0,
  },
  factIcon: { height: FACT_LINE_HEIGHT, justifyContent: 'center' },
  sideActions: { gap: spacing.compact },
  iconAction: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: 1,
    height: ICON_ACTION_SIZE,
    justifyContent: 'center',
    width: ICON_ACTION_SIZE,
  },
  saveActionEmphasized: {
    backgroundColor: colors.cream,
    borderColor: colors.cream,
  },
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
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});
