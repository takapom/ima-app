import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AttributionPresentation } from '@mobile/ui/presentation/attribution';
export type AttributionListProps = {
  readonly attributions: readonly AttributionPresentation[];
  readonly onSourcePress?: (sourceLink: string) => void;
  readonly centered?: boolean;
};

/** Source credits remain visible in results and details, including required links. */
export function AttributionList({
  attributions,
  onSourcePress,
  centered = false,
}: AttributionListProps): React.JSX.Element | null {
  if (attributions.length === 0) return null;
  return (
    <View style={[styles.attribution, centered && { justifyContent: 'center', marginTop: 0 }]}>
      {attributions.map((attribution) => {
        const sourceLink = attribution.sourceLink;
        if (sourceLink !== null && onSourcePress !== undefined) {
          return (
            <Pressable
              accessibilityLabel={`${attribution.label}を開く`}
              accessibilityRole="link"
              key={`${attribution.label}:${sourceLink}`}
              onPress={() => onSourcePress(sourceLink)}
            >
              <Text style={styles.attributionLink}>{attribution.label}</Text>
            </Pressable>
          );
        }
        return (
          <Text
            key={`${attribution.label}:${attribution.sourceLink ?? ''}`}
            style={styles.attributionText}
          >
            {attribution.label}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  attribution: { columnGap: 8, flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  attributionText: { color: '#6b6a66', fontSize: 11 },
  attributionLink: { color: '#6b6a66', fontSize: 11, textDecorationLine: 'underline' },
});
