import { StyleSheet, View } from 'react-native';
import type { CardsData } from '@ima/contracts';
import { resultAttributions } from '@mobile/journey/presentation/card-attributions';
import { AttributionList } from '@mobile/ui/AttributionList';

export function ResultsAttribution({
  cards,
  onSourcePress,
}: {
  readonly cards: CardsData | null;
  readonly onSourcePress: (sourceLink: string) => void;
}): React.JSX.Element | null {
  if (cards === null) return null;
  return (
    <View style={styles.footer}>
      <AttributionList
        centered
        attributions={resultAttributions([cards.hero, ...cards.alts])}
        onSourcePress={onSourcePress}
      />
    </View>
  );
}

const styles = StyleSheet.create({ footer: { paddingHorizontal: 14, paddingBottom: 10 } });
