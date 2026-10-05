import { useEffect, useState } from 'react';
import { Animated, Easing, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import maruMagnifier from '../../../assets/character/maru-magnifier.gif';
import {
  PLACEHOLDER_QUESTIONS,
  questionProgress,
} from '@mobile/entry/presentation/placeholder-questions';
import { Icon } from '@mobile/ui/Icon';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

const NATIVE_DRIVER = Platform.OS !== 'web';

type QuestionPlaceholderProps = {
  readonly onBack: () => void;
  readonly onFinish: () => void;
};

export function QuestionPlaceholder({
  onBack,
  onFinish,
}: QuestionPlaceholderProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  const [enter] = useState(() => new Animated.Value(0));
  const question = PLACEHOLDER_QUESTIONS[step];
  const total = PLACEHOLDER_QUESTIONS.length;

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

  const answer = () => {
    if (step + 1 >= total) {
      onFinish();
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
        <View style={styles.body}>
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
                key={option}
                onPress={answer}
                style={({ pressed }) => [styles.option, pressed && styles.pressed]}
              >
                <Text style={styles.optionText}>{option}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      <View style={styles.footer}>
        <View accessibilityLabel={`${total}問中${step + 1}問目`} accessible style={styles.progress}>
          {questionProgress(step + 1, total).map((filled, index) => (
            <View key={index} style={[styles.segment, filled && styles.segmentFilled]} />
          ))}
        </View>
        <Text style={styles.note}>仮の質問です。回答はまだチャットに渡しません。</Text>
      </View>
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
  footer: {
    gap: spacing.section,
  },
  progress: {
    flexDirection: 'row',
    gap: 6,
  },
  segment: {
    borderColor: colors.border,
    borderRadius: 4,
    borderWidth: 1,
    flex: 1,
    height: 8,
  },
  segmentFilled: {
    backgroundColor: colors.lime,
    borderColor: colors.lime,
  },
  note: {
    color: colors.faint,
    fontSize: typography.label,
  },
  pressed: {
    backgroundColor: colors.surface,
  },
});
