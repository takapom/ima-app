import { StyleSheet, Text, View } from 'react-native';
import type { PublicCard } from '@ima/contracts';
import { presentDecidedIdentity } from './decided-state-model';
import { colors, radii, spacing, typography } from '../theme/tokens';

type DecidedStateProps = {
  readonly card: PublicCard | null;
};

export function DecidedState({ card }: DecidedStateProps): React.JSX.Element {
  const identity = presentDecidedIdentity(card);
  return (
    <View style={styles.container}>
      <Text style={styles.kicker}>ここにする</Text>
      <Text style={styles.title}>{identity?.name ?? '候補を決めました'}</Text>
      {identity?.area ? <Text style={styles.area}>{identity.area}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.card,
    marginHorizontal: spacing.page,
    marginTop: spacing.section,
    padding: spacing.canvas,
  },
  kicker: {
    color: colors.lime,
    fontSize: typography.label,
    fontWeight: '700',
  },
  title: {
    color: colors.text,
    fontSize: typography.title,
    fontWeight: '800',
    marginTop: spacing.compact,
  },
  area: {
    color: colors.muted,
    fontSize: typography.label,
    marginTop: 3,
  },
});
