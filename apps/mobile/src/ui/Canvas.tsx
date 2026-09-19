import { KeyboardAvoidingView, Platform, type ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { keyboardOffsetForSafeArea } from '@mobile/ui/theme/safe-area';
import { colors } from '@mobile/ui/theme/tokens';

export function Canvas({ children, ...props }: ViewProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      {...props}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={keyboardOffsetForSafeArea(insets.bottom)}
      style={[styles.canvas, props.style]}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

const styles = {
  canvas: {
    flex: 1,
    backgroundColor: colors.background,
  },
} as const;
