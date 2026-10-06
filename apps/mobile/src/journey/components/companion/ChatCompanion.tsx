import { useCallback, useSyncExternalStore } from 'react';
import { Animated, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import maruBreath from '../../../../assets/character/maru-breath.gif';
import maruDecided from '../../../../assets/character/maru-decided.png';
import maruEmpty from '../../../../assets/character/maru-empty.png';
import maruOops from '../../../../assets/character/maru-oops.png';
import { companionSpeech } from '@mobile/journey/components/companion/companion-speech';
import type { CardSetFocus } from '@mobile/journey/state/card-set-focus';
import { useCompanionEntrance } from '@mobile/journey/hooks/useCompanionEntrance';
import { useReduceMotion } from '@mobile/journey/hooks/useReduceMotion';
import { companionPose, type CompanionPose } from '@mobile/journey/state/companion-pose';
import type { RunnerHandoff } from '@mobile/journey/state/runner-handoff';
import type { JourneyPhase } from '@mobile/journey/state/journey-shell';
import { colors, radii, spacing, typography } from '@mobile/ui/theme/tokens';

const DOG_SIZE = 64;
// While away the corner keeps a hidden dog so it can measure where to land.
const SOURCES: Record<CompanionPose, number> = {
  idle: maruBreath,
  away: maruBreath,
  notFound: maruEmpty,
  oops: maruOops,
  happy: maruDecided,
};

/** Least space the transcript keeps free at its end; a speech bubble makes it taller. */
export const COMPANION_SPACE = DOG_SIZE;

/**
 * The dog at the bottom right of the chat: it reacts to the screen state, reads out the reason of
 * the card in view, and is away while it runs in the conversation during a search.
 */
export function ChatCompanion({
  phase,
  noCandidates,
  focus,
  handoff,
  onLayout,
}: {
  readonly phase: JourneyPhase;
  readonly noCandidates: boolean;
  readonly focus: CardSetFocus;
  readonly handoff: RunnerHandoff;
  readonly onLayout: (event: LayoutChangeEvent) => void;
}): React.JSX.Element {
  const subscribe = useCallback((listener: () => void) => focus.subscribe(listener), [focus]);
  const focused = useSyncExternalStore(subscribe, focus.current, focus.current);
  const speech = companionSpeech(focused);
  const { pose, bubble } = companionPose({ phase, noCandidates, speech: speech?.text ?? null });
  const meta = speech !== null && bubble === speech.text ? speech : null;
  // Only a new pose moves the dog; swiping cards swaps the line in place without moving it.
  const entrance = useCompanionEntrance({
    pose,
    handoff,
    reduceMotion: useReduceMotion(),
    dogSize: DOG_SIZE,
  });

  return (
    <View onLayout={onLayout} pointerEvents="none" style={styles.anchor}>
      {bubble === null ? null : (
        // Only "nothing found" is announced; card reasons change on every swipe and stay readable.
        <Animated.View
          accessibilityLiveRegion={pose === 'notFound' ? 'polite' : 'none'}
          style={[styles.bubble, entrance.bubbleStyle]}
        >
          {meta === null ? null : (
            <View style={styles.bubbleMeta}>
              {meta.position === null ? null : (
                <Text style={styles.bubblePosition}>{meta.position}</Text>
              )}
              <Text style={styles.bubbleRelation}>{meta.relation}</Text>
            </View>
          )}
          <Text style={styles.bubbleText}>{bubble}</Text>
          <View style={styles.bubbleTail} />
        </Animated.View>
      )}
      <View collapsable={false} ref={entrance.dogRef} style={styles.dog}>
        <Animated.Image
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          source={SOURCES[pose]}
          style={[styles.dog, entrance.dogStyle]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    alignItems: 'flex-end',
    bottom: 0,
    flexDirection: 'row',
    gap: 2,
    justifyContent: 'flex-end',
    left: spacing.page,
    position: 'absolute',
    right: spacing.page,
  },
  bubble: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radii.small,
    borderWidth: 1,
    flexShrink: 1,
    marginBottom: DOG_SIZE / 2,
    paddingHorizontal: spacing.section,
    paddingVertical: spacing.compact,
  },
  bubbleMeta: {
    flexDirection: 'row',
    gap: spacing.compact,
    marginBottom: 2,
  },
  bubblePosition: {
    color: colors.lime,
    fontSize: typography.label,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  bubbleRelation: {
    color: colors.muted,
    fontSize: typography.label,
  },
  bubbleText: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '600',
    lineHeight: 20,
  },
  bubbleTail: {
    position: 'absolute',
    right: -6,
    bottom: 10,
    width: 10,
    height: 10,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRightWidth: 1,
    borderTopWidth: 1,
    transform: [{ rotate: '45deg' }],
  },
  dog: {
    height: DOG_SIZE,
    width: DOG_SIZE,
  },
});
