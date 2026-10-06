import { useCallback, useReducer, useState, type ReactNode } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';
import { EntryIntro } from '@mobile/entry/components/EntryIntro';
import { CompletionScreen } from '@mobile/entry/components/CompletionScreen';
import { QuestionScreen } from '@mobile/entry/components/QuestionScreen';
import {
  entryCovers,
  initialEntryStage,
  introMayStart,
  reduceEntryStage,
  type ChatReadiness,
  type EntryEvent,
  type EntryRoute,
} from '@mobile/entry/state/entry-flow';
import { colors } from '@mobile/ui/theme/tokens';

const NATIVE_DRIVER = Platform.OS !== 'web';

/**
 * Covers the chat with the splash and the chat/questions choice on every launch.
 * The chat stays mounted underneath so its runtime starts while the splash plays.
 * Connection and error screens are left uncovered.
 */
export function EntryFlow({
  readiness,
  onQuestionsAnswered,
  children,
}: {
  readonly readiness: ChatReadiness;
  /** Receives the answers written as one message, to be sent as the first chat message. */
  readonly onQuestionsAnswered: (query: string) => void;
  readonly children: ReactNode;
}): React.JSX.Element {
  const [stage, dispatch] = useReducer(reduceEntryStage, initialEntryStage);
  const [overlay] = useState(() => new Animated.Value(1));
  const [leaving, setLeaving] = useState(false);
  const [sentQuery, setSentQuery] = useState('');
  const showChoices = useCallback(() => dispatch({ type: 'splashFinished' }), []);
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
  const finishCompletion = useCallback(
    () => leaveWith({ type: 'completionFinished' }),
    [leaveWith],
  );
  const covering = entryCovers(stage, readiness);
  const introHidden = stage === 'questions' || stage === 'complete';

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
            accessibilityElementsHidden={introHidden}
            importantForAccessibility={introHidden ? 'no-hide-descendants' : 'auto'}
            style={styles.root}
          >
            <EntryIntro
              canStart={introMayStart(readiness)}
              interactive={stage === 'choosing' && !leaving}
              onChoicesShown={showChoices}
              onChoose={choose}
            />
          </View>
          {stage === 'questions' ? (
            <View style={[StyleSheet.absoluteFill, styles.overlay]}>
              <QuestionScreen
                onBack={() => dispatch({ type: 'questionsBack' })}
                onFinish={(query) => {
                  setSentQuery(query);
                  onQuestionsAnswered(query);
                  dispatch({ type: 'questionsFinished' });
                }}
              />
            </View>
          ) : null}
          {stage === 'complete' ? (
            <View style={[StyleSheet.absoluteFill, styles.overlay]}>
              <CompletionScreen query={sentQuery} onDone={finishCompletion} />
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
