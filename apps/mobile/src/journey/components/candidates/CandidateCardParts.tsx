import { StyleSheet, Text, View } from 'react-native';
import type { CardOpening } from '@mobile/journey/presentation/candidate-card-view';
import { colors, radii, typography } from '@mobile/ui/theme/tokens';
import { Icon } from '@mobile/ui/Icon';

export function StatusPill({
  opening,
}: {
  readonly opening: CardOpening;
}): React.JSX.Element | null {
  if (opening.kind === 'none' || opening.kind === 'listed') return null;

  if (opening.kind === 'closed') {
    return (
      <View style={[styles.pill, styles.pillQuiet]}>
        <View style={[styles.dot, styles.dotQuiet]} />
        <Text style={styles.pillQuietText}>
          {opening.reopensAtLabel === null
            ? '本日は終了'
            : `本日は終了 · ${opening.reopensAtLabel}から`}
        </Text>
      </View>
    );
  }

  // Closing soon is the card's single escalation: the pill fills instead of adding another element.
  if (opening.kind === 'closing') {
    return (
      <View style={[styles.pill, styles.pillUrgent]}>
        <Icon name="clock" color={colors.ink} size={13} />
        <Text style={styles.pillUrgentText}>あと{opening.remainingMinutes}分で閉店</Text>
      </View>
    );
  }

  return (
    <View style={[styles.pill, styles.pillGlass]}>
      <View style={styles.dot} />
      <Text style={styles.pillText}>
        営業中 <Text style={styles.pillAccent}>· あと{opening.remainingMinutes}分</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  pillGlass: {
    backgroundColor: 'rgba(10, 10, 11, 0.52)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderWidth: 1,
  },
  pillQuiet: {
    backgroundColor: 'rgba(10, 10, 11, 0.5)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderWidth: 1,
  },
  pillUrgent: {
    backgroundColor: colors.lime,
  },
  pillText: {
    color: '#e9eddb',
    fontSize: typography.label,
    fontWeight: '700',
  },
  pillAccent: {
    color: colors.lime,
  },
  pillQuietText: {
    color: '#8c8b85',
    fontSize: typography.label,
    fontWeight: '700',
  },
  pillUrgentText: {
    color: colors.ink,
    fontSize: typography.label,
    fontWeight: '800',
  },
  dot: {
    backgroundColor: colors.lime,
    borderRadius: radii.pill,
    height: 7,
    width: 7,
  },
  dotQuiet: {
    backgroundColor: '#55544f',
  },
});
