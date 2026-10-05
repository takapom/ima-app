import type { JourneyPhase } from '@mobile/journey/state/journey-shell';

export type CompanionPose = 'idle' | 'search' | 'notFound' | 'oops' | 'happy';

export type CompanionState = {
  readonly pose: CompanionPose;
  readonly bubble: string | null;
};

/**
 * The dog that stays in the chat follows the screen state. "Nothing found" is said only when the
 * latest reply carries the worker's no-candidates signal; failed or cancelled sends never claim it.
 */
export function companionPose({
  phase,
  noCandidates,
}: {
  readonly phase: JourneyPhase;
  readonly noCandidates: boolean;
}): CompanionState {
  switch (phase) {
    case 'working':
      return { pose: 'search', bubble: null };
    case 'error':
    case 'cancelled':
      return { pose: 'oops', bubble: null };
    case 'decided':
      return { pose: 'happy', bubble: null };
    case 'results':
      return noCandidates
        ? { pose: 'notFound', bubble: '見つからなかったわん' }
        : { pose: 'idle', bubble: null };
    case 'empty':
      return { pose: 'idle', bubble: null };
  }
}
