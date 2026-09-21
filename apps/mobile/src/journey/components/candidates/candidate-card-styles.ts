import { StyleSheet } from 'react-native';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

export const CANDIDATE_THUMBNAIL_SIZE = 76;
const ACTION_SIZE = 36;

export const styles = StyleSheet.create({
  card: {
    minHeight: 240,
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.card,
    padding: spacing.section,
    gap: spacing.compact,
  },
  summary: {
    alignItems: 'center',
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
  heading: { flex: 1, minWidth: 0, gap: spacing.compact },
  category: { color: colors.muted, fontSize: typography.label },
  name: { color: colors.text, fontSize: typography.cardTitle, fontWeight: '700' },
  dimmedText: { color: colors.muted },
  diff: { color: colors.muted, fontSize: typography.label },
  meta: { color: colors.muted, fontSize: typography.label },
  closing: { color: colors.lime, fontWeight: '700' },
  metaRow: { flexDirection: 'row', gap: spacing.compact },
  access: { flex: 1, minWidth: 0 },
  price: { flexShrink: 1, maxWidth: '65%' },
  sourceLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.compact,
    minHeight: ACTION_SIZE,
    minWidth: spacing.touch,
  },
  sourceUrl: {
    flex: 1,
    color: colors.muted,
    fontSize: typography.label,
    textDecorationLine: 'underline',
  },
  actionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.compact,
    marginTop: 'auto',
    minHeight: 44,
  },
  peekAction: {
    alignItems: 'center',
    backgroundColor: colors.cream,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 5,
    height: ACTION_SIZE,
    justifyContent: 'center',
    paddingLeft: 16,
    paddingRight: 14,
  },
  peekActionText: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  saveAction: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: 1,
    height: ACTION_SIZE,
    justifyContent: 'center',
    marginLeft: 'auto',
    width: ACTION_SIZE,
  },
  saveActionEmphasized: {
    backgroundColor: colors.cream,
    borderColor: colors.cream,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});
