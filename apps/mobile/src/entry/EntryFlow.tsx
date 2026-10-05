import { useCallback, useReducer, useState, type ReactNode } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';
import { EntryIntro } from '@mobile/entry/components/EntryIntro';
import { QuestionPlaceholder } from '@mobile/entry/components/QuestionPlaceholder';
import {
  initialEntryStage,
  reduceEntryStage,
  type EntryEvent,
  type EntryRoute,
} from '@mobile/entry/state/entry-flow';
import { colors } from '@mobile/ui/theme/tokens';

const NATIVE_DRIVER = Platform.OS !== 'web';

/**
 * Covers the chat with the splash and the chat/questions choice on every launch.
 * The chat stays mounted underneath so its runtime starts while the splash plays.
 */
export function EntryFlow({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [stage, dispatch] = useReducer(reduceEntryStage, initialEntryStage);
  const [overlay] = useState(() => new Animated.Value(1));
  const [leaving, setLeaving] = useState(false);
  const finishSplash = useCallback(() => dispatch({ type: 'splashFinished' }), []);
  const leaveWith = useCallback(
    (event: EntryEvent) => {
      setLeaving(true);
      Animated.timing(overlay, {
        toValue: 0,
        duration: 240,
        easing: Easing.out(Easing.quad),
        useNativeDriver: NATIVE_DRIVER,
      }).start(() => dispatch(event));
    },
    [overlay],
  );
  const choose = useCallback(
    (route: EntryRoute) => {
      if (route === 'chat') {
        leaveWith({ type: 'choose', route });
        return;
      }
      dispatch({ type: 'choose', route });
    },
    [leaveWith],
  );
  const covering = stage !== 'chat';

  return (
    <View style={styles.root}>
      <View
        accessibilityElementsHidden={covering}
        importantForAccessibility={covering ? 'no-hide-descendants' : 'auto'}
        style={styles.root}
      >
        {children}
      </View>
      {covering ? (
        <Animated.View
          pointerEvents={leaving ? 'none' : 'auto'}
          style={[StyleSheet.absoluteFill, styles.overlay, { opacity: overlay }]}
        >
          <View
            accessibilityElementsHidden={stage === 'questions'}
            importantForAccessibility={stage === 'questions' ? 'no-hide-descendants' : 'auto'}
            style={styles.root}
          >
            <EntryIntro
              interactive={stage === 'choosing' && !leaving}
              onSplashFinished={finishSplash}
              onChoose={choose}
            />
          </View>
          {stage === 'questions' ? (
            <View style={[StyleSheet.absoluteFill, styles.overlay]}>
              <QuestionPlaceholder
                onBack={() => dispatch({ type: 'questionsBack' })}
                onFinish={() => leaveWith({ type: 'questionsFinished' })}
              />
            </View>
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  overlay: {
    backgroundColor: colors.background,
  },
});
