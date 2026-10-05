import { useEffect, useMemo, useState } from 'react';
import { Animated, Easing, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import maruMagnifier from '../../../assets/character/maru-magnifier.gif';
import { QuestionProgress } from '@mobile/entry/components/QuestionProgress';
import {
  composeQuestionQuery,
  progressSegments,
  questionsFor,
  type EntryAnswers,
  type EntryQuestionId,
} from '@mobile/entry/presentation/entry-questions';
import { Icon } from '@mobile/ui/Icon';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

const NATIVE_DRIVER = Platform.OS !== 'web';

type QuestionScreenProps = {
  readonly onBack: () => void;
  /** Receives the answers written as the first chat message. */
  readonly onFinish: (query: string) => void;
};

export function QuestionScreen({ onBack, onFinish }: QuestionScreenProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<EntryAnswers>({});
  const [enter] = useState(() => new Animated.Value(0));
  const [stepIn] = useState(() => new Animated.Value(1));
  const questions = questionsFor(answers);
  const question = questions[step];
  const total = questions.length;
  const segments = useMemo(() => progressSegments(step, total), [step, total]);

  useEffect(() => {
    const animation = Animated.timing(enter, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: NATIVE_DRIVER,
    });
    animation.start();
    return () => animation.stop();
  }, [enter]);

  useEffect(() => {
    stepIn.setValue(0);
    const animation = Animated.timing(stepIn, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: NATIVE_DRIVER,
    });
    animation.start();
    return () => animation.stop();
  }, [step, stepIn]);

  const answer = (questionId: EntryQuestionId, label: string) => {
    const next = { ...answers, [questionId]: label };
    setAnswers(next);
    if (step + 1 >= total) {
      onFinish(composeQuestionQuery(next));
      return;
    }
    setStep(step + 1);
  };

  return (
    <Animated.View
      style={[
        styles.screen,
        { paddingTop: insets.top + spacing.compact, paddingBottom: insets.bottom + spacing.canvas },
        {
          opacity: enter,
          transform: [
            { translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }) },
          ],
        },
      ]}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={step === 0 ? '選び直す' : '前の質問に戻る'}
          hitSlop={8}
          onPress={() => (step === 0 ? onBack() : setStep(step - 1))}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <Icon name="back" color={colors.text} size={20} />
        </Pressable>
        <Text style={styles.caption}>質問で探す</Text>
      </View>

      {question === undefined ? null : (
        <Animated.View
          style={[
            styles.body,
            {
              opacity: stepIn,
              transform: [
                { translateY: stepIn.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
              ],
            },
          ]}
        >
          <View style={styles.titleRow}>
            <Text style={styles.title}>{question.title}</Text>
            <Image
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              source={maruMagnifier}
              style={styles.dog}
            />
          </View>
          <View style={styles.options}>
            {question.options.map((option) => (
              <Pressable
                accessibilityRole="button"
                key={option.label}
                onPress={() => answer(question.id, option.label)}
                style={({ pressed }) => [
                  styles.option,
                  answers[question.id] === option.label && styles.chosen,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.optionText}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      )}

      <QuestionProgress segments={segments} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.canvas,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.compact,
    minHeight: spacing.touch,
  },
  back: {
    alignItems: 'center',
    borderRadius: radii.pill,
    height: 40,
    justifyContent: 'center',
    marginLeft: -spacing.compact,
    width: 40,
  },
  caption: {
    color: colors.muted,
    fontSize: typography.label,
    fontWeight: '600',
  },
  body: {
    flex: 1,
    gap: spacing.section * 2,
    justifyContent: 'center',
  },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  title: {
    color: colors.text,
    flex: 1,
    fontSize: typography.title,
    fontWeight: '800',
    letterSpacing: -0.6,
  },
  dog: {
    height: 72,
    width: 72,
  },
  options: {
    gap: spacing.compact,
  },
  option: {
    backgroundColor: '#101010',
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: spacing.section + 4,
    paddingVertical: spacing.section + 2,
  },
  optionText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  chosen: {
    borderColor: colors.lime,
  },
  pressed: {
    backgroundColor: colors.surface,
  },
});
