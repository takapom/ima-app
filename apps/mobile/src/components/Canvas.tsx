import { KeyboardAvoidingView, Platform, type ViewProps } from 'react-native';
import { colors } from '../theme/tokens';

export function Canvas({ children, ...props }: ViewProps): React.JSX.Element {
  return (
    <KeyboardAvoidingView
      {...props}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
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
