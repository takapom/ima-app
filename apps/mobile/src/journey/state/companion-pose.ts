import type { JourneyPhase } from '@mobile/journey/state/journey-shell';

/** `away`: the dog is running in the conversation during a search, so the corner is empty. */
export type CompanionPose = 'idle' | 'away' | 'notFound' | 'oops' | 'happy';

export type CompanionState = {
  readonly pose: CompanionPose;
  readonly bubble: string | null;
};

/**
 * The dog that stays in the chat follows the screen state. "Nothing found" is said only when the
 * latest reply carries the worker's no-candidates signal; failed or cancelled sends never claim it.
 * Otherwise it reads out the generated reason of the card in view, word for word.
 */
export function companionPose({
  phase,
  noCandidates,
  speech,
}: {
  readonly phase: JourneyPhase;
  readonly noCandidates: boolean;
  readonly speech: string | null;
}): CompanionState {
  switch (phase) {
    case 'working':
      return { pose: 'away', bubble: null };
    case 'error':
    case 'cancelled':
      return { pose: 'oops', bubble: null };
    case 'decided':
      return { pose: 'happy', bubble: null };
    case 'results':
      return noCandidates
        ? { pose: 'notFound', bubble: '見つからなかったわん' }
        : { pose: 'idle', bubble: speech };
    case 'empty':
      return { pose: 'idle', bubble: speech };
  }
}

export type CompanionEntrance = 'jumpIn' | 'hop' | 'none';

/** Coming back from a search is a jump from the runner; any other change of pose is a hop. */
export const companionEntrance = (
  previous: CompanionPose,
  next: CompanionPose,
): CompanionEntrance =>
  next === 'away' || previous === next ? 'none' : previous === 'away' ? 'jumpIn' : 'hop';
