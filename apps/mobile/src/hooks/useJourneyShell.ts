import { useCallback, useReducer } from 'react';
import {
  createJourneyShellState,
  journeyShellReducer,
  type DrawerView,
  type JourneyShellState,
} from '../state/journey-shell';
import type { AssistantResponseState } from '../state/assistant-response';
import type { ConditionScope, JourneyConditions } from '../state/journey-input';

export type JourneyShellController = JourneyShellState & {
  readonly beginRequest: (query: string) => void;
  readonly applyResponse: (responseState: JourneyShellState['responseState']) => void;
  readonly settleResponse: (revision: number) => void;
  readonly failRequest: (message: string) => void;
  readonly cancelRequest: () => void;
  readonly decide: (candidateId: string, responseState?: AssistantResponseState) => void;
  readonly updateDraft: (value: string) => void;
  readonly removeChip: (label: string) => void;
  readonly changeConditionScope: (scope: ConditionScope) => void;
  readonly updateConditions: (scope: ConditionScope, changes: Partial<JourneyConditions>) => void;
  readonly toggleDrawer: () => void;
  readonly closeDrawer: () => void;
  readonly setDrawerView: (view: DrawerView) => void;
  readonly reset: () => void;
};

export const useJourneyShell = (
  threadId = 'mobile-thread',
  initialSavedConditions?: JourneyConditions,
): JourneyShellController => {
  const [state, dispatch] = useReducer(journeyShellReducer, threadId, (id) =>
    createJourneyShellState(id, initialSavedConditions),
  );
  const beginRequest = useCallback(
    (query: string) => dispatch({ type: 'beginRequest', query }),
    [],
  );
  const applyResponse = useCallback(
    (responseState: JourneyShellState['responseState']) =>
      dispatch({ type: 'responseApplied', responseState }),
    [],
  );
  const settleResponse = useCallback(
    (revision: number) => dispatch({ type: 'responseSettled', revision }),
    [],
  );
  const failRequest = useCallback(
    (message: string) => dispatch({ type: 'requestFailed', message }),
    [],
  );
  const cancelRequest = useCallback(() => dispatch({ type: 'cancelRequest' }), []);
  const decide = useCallback(
    (candidateId: string, responseState?: AssistantResponseState) =>
      responseState === undefined
        ? dispatch({ type: 'decided', candidateId })
        : dispatch({ type: 'decided', candidateId, responseState }),
    [],
  );
  const updateDraft = useCallback((value: string) => dispatch({ type: 'draftChanged', value }), []);
  const removeChip = useCallback((label: string) => dispatch({ type: 'chipRemoved', label }), []);
  const changeConditionScope = useCallback(
    (scope: ConditionScope) => dispatch({ type: 'conditionScopeChanged', scope }),
    [],
  );
  const updateConditions = useCallback(
    (scope: ConditionScope, changes: Partial<JourneyConditions>) =>
      dispatch({ type: 'conditionChanged', scope, changes }),
    [],
  );
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
    settleResponse,
    failRequest,
    cancelRequest,
    decide,
    updateDraft,
    removeChip,
    changeConditionScope,
    updateConditions,
    toggleDrawer,
    closeDrawer,
    setDrawerView,
    reset,
  };
};
