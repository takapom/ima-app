import { View, type ViewProps } from 'react-native';
import { colors } from '../theme/tokens';

export function Canvas({ children, ...props }: ViewProps): React.JSX.Element {
  return (
    <View {...props} style={[styles.canvas, props.style]}>
      {children}
    </View>
  );
}

const styles = {
  canvas: {
    flex: 1,
    backgroundColor: colors.background,
  },
} as const;
