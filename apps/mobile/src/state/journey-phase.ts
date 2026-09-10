import type { JourneyPhase } from './journey-shell';

export type JourneyRequestStatus = 'idle' | 'pending' | 'error' | 'cancelled';

export const resolveJourneyPhase = (
  requestStatus: JourneyRequestStatus,
  localPhase: JourneyPhase,
  hasResponse: boolean,
  hasDecidedCard: boolean,
  hasFreshResponse = false,
): JourneyPhase => {
  if (requestStatus === 'pending') return 'working';
  if (requestStatus === 'error') return 'error';
  if (requestStatus === 'cancelled') return 'cancelled';
  if (localPhase === 'cancelled') return 'cancelled';
  if (localPhase === 'error') return 'error';
  if (localPhase === 'working' && !hasFreshResponse) return 'working';
  if (localPhase === 'decided' && hasDecidedCard) return 'decided';
  if (hasResponse) return 'results';
  return 'empty';
};
