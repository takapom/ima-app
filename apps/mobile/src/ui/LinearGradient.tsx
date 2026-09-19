import { Platform, View, type ViewStyle } from 'react-native';

/** RN 0.86 draws native gradients; Expo Web uses the corresponding CSS property. */
export function LinearGradient({
  value,
  style,
}: {
  readonly value: string;
  readonly style: ViewStyle;
}): React.JSX.Element {
  const background =
    Platform.OS === 'web' ? { backgroundImage: value } : { experimental_backgroundImage: value };
  return <View pointerEvents="none" accessible={false} style={[style, background]} />;
}
