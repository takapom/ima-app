import { StyleSheet, Text, View } from 'react-native';
import type { CardOpening } from '@mobile/journey/presentation/candidate-card-view';
import { colors, radii, typography } from '@mobile/ui/theme/tokens';

/**
 * Bottom-up scrim behind the name. No gradient library is installed, so the ramp is a stack
 * of flat bands; six steps is enough that the seams do not read at card size.
 */
const SCRIM_BANDS = [0, 0.2, 0.45, 0.68, 0.85, 0.96] as const;

export function PhotoScrim(): React.JSX.Element {
  return (
    <View style={styles.scrim}>
      {SCRIM_BANDS.map((alpha) => (
        <View
          key={alpha}
          style={[styles.scrimBand, { backgroundColor: `rgba(9, 9, 10, ${alpha})` }]}
        />
      ))}
    </View>
  );
}

/** Pure decoration; the surrounding pressable owns the accessible name. */
export function Chevron({ tone = colors.faint }: { readonly tone?: string }): React.JSX.Element {
  return <View style={[styles.chevron, { borderColor: tone }]} />;
}

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

/**
 * The loudest line in the card body. Times carry the emphasis; the words around them recede,
 * so the eye lands on the numbers without another type size being introduced.
 */
export function HoursLine({
  opening,
  dimmed,
}: {
  readonly opening: CardOpening;
  readonly dimmed: boolean;
}): React.JSX.Element | null {
  if (opening.kind === 'none') return null;
  const valueStyle = dimmed ? styles.hoursValueDim : styles.hoursValue;
  const tailStyle = dimmed ? styles.hoursTailDim : styles.hoursTail;

  if (opening.kind === 'listed') {
    return (
      <View style={styles.hoursRow}>
        <Text numberOfLines={2} style={valueStyle}>
          {opening.text}
        </Text>
      </View>
    );
  }

  if (opening.kind === 'closed') {
    return (
      <View style={styles.hoursRow}>
        <Text style={valueStyle}>
          {opening.reopensAtLabel ?? '営業時間外'}
          {opening.reopensAtLabel === null ? '' : <Text style={tailStyle}> から営業</Text>}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.hoursRow}>
      <Text style={valueStyle}>
        {opening.closesAtLabel}
        <Text style={tailStyle}> まで営業</Text>
      </Text>
      {opening.lastOrderLabel === null ? null : (
        <Text style={styles.lastOrder}>
          料理L.O.{' '}
          <Text style={dimmed ? styles.lastOrderValueDim : styles.lastOrderValue}>
            {opening.lastOrderLabel}
          </Text>
        </Text>
      )}
    </View>
  );
}

/**
 * Access and price sit on separate lines. The provider's access text is a full building
 * address plus route ("大阪駅前第4ビルB1F 地下鉄御堂筋線 梅田駅 徒歩4分/JR…"), so sharing one
 * truncating line with it would routinely push the price out of the card entirely.
 */
export function MetaLine({
  access,
  price,
  dimmed,
}: {
  readonly access: string | null;
  readonly price: string | null;
  readonly dimmed: boolean;
}): React.JSX.Element | null {
  if (access === null && price === null) return null;
  const valueStyle = dimmed ? styles.metaValueDim : styles.metaValue;
  return (
    <View>
      {access === null ? null : (
        <Text numberOfLines={1} style={styles.metaLine}>
          <Text style={valueStyle}>{access}</Text>
        </Text>
      )}
      {price === null ? null : (
        <Text numberOfLines={1} style={access === null ? styles.metaLine : styles.metaLineNext}>
          <Text style={valueStyle}>{price}</Text>
        </Text>
      )}
    </View>
  );
}

/**
 * Amenities drop a tier by changing form, not by shrinking below the readable floor:
 * chips keep 11px legible against their own fill.
 */
export function AmenityChips({
  amenities,
  dimmed,
}: {
  readonly amenities: readonly string[];
  readonly dimmed: boolean;
}): React.JSX.Element | null {
  if (amenities.length === 0) return null;
  return (
    <View style={styles.chipRow}>
      {amenities.map((label) => (
        <View key={label} style={[styles.chip, dimmed ? styles.chipDim : null]}>
          <Text style={dimmed ? styles.chipTextDim : styles.chipText}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    bottom: 0,
    pointerEvents: 'none',
    height: '62%',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  scrimBand: {
    flex: 1,
  },
  chevron: {
    borderRightWidth: 2,
    borderTopWidth: 2,
    height: 9,
    transform: [{ rotate: '45deg' }],
    width: 9,
  },
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
    backgroundColor: 'rgba(10, 10, 11, 0.62)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderWidth: 1,
  },
  pillQuiet: {
    backgroundColor: 'rgba(10, 10, 11, 0.6)',
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
  hoursRow: {
    alignItems: 'baseline',
    columnGap: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  hoursValue: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 27,
  },
  hoursValueDim: {
    color: '#b9b8b1',
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 27,
  },
  hoursTail: {
    color: '#b9b8b1',
    fontSize: 13,
    fontWeight: '600',
  },
  hoursTailDim: {
    color: '#8c8b85',
    fontSize: 13,
    fontWeight: '600',
  },
  lastOrder: {
    color: '#7c7b76',
    fontSize: 13,
    lineHeight: 21,
  },
  lastOrderValue: {
    color: '#b9b8b1',
    fontWeight: '600',
  },
  lastOrderValueDim: {
    color: '#8c8b85',
    fontWeight: '600',
  },
  metaLine: {
    color: '#7c7b76',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 12,
  },
  metaLineNext: {
    color: '#7c7b76',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 4,
  },
  metaValue: {
    color: colors.text,
    fontWeight: '600',
  },
  metaValueDim: {
    color: '#8c8b85',
    fontWeight: '600',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12,
  },
  chip: {
    backgroundColor: '#1e1e22',
    borderRadius: radii.pill,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  chipDim: {
    backgroundColor: '#1a1a1d',
  },
  chipText: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '600',
  },
  chipTextDim: {
    color: '#7c7b76',
    fontSize: 11,
    fontWeight: '600',
  },
});
