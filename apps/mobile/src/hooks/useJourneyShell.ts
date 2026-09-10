import { useCallback, useReducer } from 'react';
import {
  createJourneyShellState,
  journeyShellReducer,
  type DrawerView,
  type JourneyShellState,
} from '../state/journey-shell';
import type { AssistantResponseState } from '../state/assistant-response';

export type JourneyShellController = JourneyShellState & {
  readonly beginRequest: (query: string) => void;
  readonly applyResponse: (responseState: JourneyShellState['responseState']) => void;
  readonly failRequest: (message: string) => void;
  readonly decide: (candidateId: string, responseState?: AssistantResponseState) => void;
  readonly updateDraft: (value: string) => void;
  readonly toggleDrawer: () => void;
  readonly closeDrawer: () => void;
  readonly setDrawerView: (view: DrawerView) => void;
  readonly reset: () => void;
};

export const useJourneyShell = (threadId = 'mobile-thread'): JourneyShellController => {
  const [state, dispatch] = useReducer(journeyShellReducer, threadId, createJourneyShellState);
  const beginRequest = useCallback(
    (query: string) => dispatch({ type: 'beginRequest', query }),
    [],
  );
  const applyResponse = useCallback(
    (responseState: JourneyShellState['responseState']) =>
      dispatch({ type: 'responseApplied', responseState }),
    [],
  );
  const failRequest = useCallback(
    (message: string) => dispatch({ type: 'requestFailed', message }),
    [],
  );
  const decide = useCallback(
    (candidateId: string, responseState?: AssistantResponseState) =>
      responseState === undefined
        ? dispatch({ type: 'decided', candidateId })
        : dispatch({ type: 'decided', candidateId, responseState }),
    [],
  );
  const updateDraft = useCallback((value: string) => dispatch({ type: 'draftChanged', value }), []);
  const toggleDrawer = useCallback(() => dispatch({ type: 'toggleDrawer' }), []);
  const closeDrawer = useCallback(() => dispatch({ type: 'closeDrawer' }), []);
  const setDrawerView = useCallback(
    (view: DrawerView) => dispatch({ type: 'setDrawerView', view }),
    [],
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return {
    ...state,
    beginRequest,
    applyResponse,
    failRequest,
    decide,
    updateDraft,
    toggleDrawer,
    closeDrawer,
    setDrawerView,
    reset,
  };
};
