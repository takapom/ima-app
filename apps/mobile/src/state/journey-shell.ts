import { createAssistantResponseState, type AssistantResponseState } from './assistant-response';
import {
  conditionChangesForChip,
  createDefaultJourneyConditions,
  mergeChipLabels,
  preferenceChipLabels,
  type ConditionScope,
  type JourneyConditions,
} from './journey-input';

export type JourneyPhase = 'empty' | 'working' | 'results' | 'decided' | 'error' | 'cancelled';
export type JourneyRequestState = 'idle' | 'pending' | 'error' | 'cancelled';

export type DrawerView = 'home' | 'history' | 'saved' | 'conditions';

export type SearchHistoryItem = {
  readonly id: string;
  readonly label: string;
  readonly query: string;
  readonly time: string;
};

export type SavedPlaceItem = {
  readonly id: string;
  readonly name: string;
  readonly area: string;
};

export type JourneyShellState = {
  readonly phase: JourneyPhase;
  readonly requestState: JourneyRequestState;
  readonly query: string;
  readonly draft: string;
  readonly chips: readonly string[];
  readonly removedChipLabels: readonly string[];
  readonly conditions: JourneyConditions;
  readonly savedConditions: JourneyConditions;
  readonly conditionScope: ConditionScope;
  readonly drawerOpen: boolean;
  readonly drawerView: DrawerView;
  readonly selectedCandidateId: string | null;
  readonly errorMessage: string | null;
  readonly responseState: AssistantResponseState;
};

export type JourneyShellAction =
  | { readonly type: 'draftChanged'; readonly value: string }
  | { readonly type: 'beginRequest'; readonly query: string }
  | { readonly type: 'responseApplied'; readonly responseState: AssistantResponseState }
  | { readonly type: 'requestFailed'; readonly message: string }
  | { readonly type: 'cancelRequest' }
  | { readonly type: 'chipRemoved'; readonly label: string }
  | { readonly type: 'conditionScopeChanged'; readonly scope: ConditionScope }
  | {
      readonly type: 'conditionChanged';
      readonly scope: ConditionScope;
      readonly changes: Partial<JourneyConditions>;
    }
  | {
      readonly type: 'decided';
      readonly candidateId: string;
      readonly responseState?: AssistantResponseState;
    }
  | { readonly type: 'toggleDrawer' }
  | { readonly type: 'closeDrawer' }
  | { readonly type: 'setDrawerView'; readonly view: DrawerView }
  | { readonly type: 'reset' };

export const createJourneyShellState = (
  threadId: string,
  initialSavedConditions: JourneyConditions = createDefaultJourneyConditions(),
): JourneyShellState => ({
  phase: 'empty',
  requestState: 'idle',
  query: '',
  draft: '',
  chips: [],
  removedChipLabels: [],
  conditions: initialSavedConditions,
  savedConditions: initialSavedConditions,
  conditionScope: 'thread',
  drawerOpen: false,
  drawerView: 'home',
  selectedCandidateId: null,
  errorMessage: null,
  responseState: createAssistantResponseState(threadId),
});

const hasCandidate = (
  state: JourneyShellState,
  candidateId: string,
  responseState = state.responseState,
): boolean => {
  const cards = responseState.cards;
  return (
    cards !== null && [cards.hero, ...cards.alts].some((card) => card.candidateId === candidateId)
  );
};

export const journeyShellReducer = (
  state: JourneyShellState,
  action: JourneyShellAction,
): JourneyShellState => {
  switch (action.type) {
    case 'draftChanged':
      return { ...state, draft: action.value };
    case 'beginRequest': {
      const query = action.query.trim();
      return query.length === 0
        ? state
        : {
            ...state,
            phase: 'working',
            requestState: 'pending',
            query: action.query,
            chips: mergeChipLabels(
              preferenceChipLabels(state.conditions),
              action.query,
              state.removedChipLabels,
            ),
            selectedCandidateId: null,
            errorMessage: null,
            drawerOpen: false,
          };
    }
    case 'responseApplied':
      return {
        ...state,
        responseState: action.responseState,
        requestState: 'idle',
        phase: action.responseState.revision > 0 ? 'results' : state.phase,
        draft: action.responseState.revision > 0 ? '' : state.draft,
        removedChipLabels: action.responseState.revision > 0 ? [] : state.removedChipLabels,
        errorMessage: null,
      };
    case 'requestFailed':
      return { ...state, phase: 'error', requestState: 'error', errorMessage: action.message };
    case 'cancelRequest':
      return {
        ...state,
        phase: 'cancelled',
        requestState: 'cancelled',
        errorMessage: null,
      };
    case 'chipRemoved': {
      const changes = conditionChangesForChip(state.conditions, action.label);
      const nextConditions = { ...state.conditions, ...changes };
      const removedChipLabels = state.removedChipLabels.includes(action.label)
        ? state.removedChipLabels
        : [...state.removedChipLabels, action.label];
      return {
        ...state,
        conditions: nextConditions,
        chips: mergeChipLabels(
          preferenceChipLabels(nextConditions),
          state.query,
          removedChipLabels,
        ),
        removedChipLabels,
      };
    }
    case 'conditionScopeChanged':
      return { ...state, conditionScope: action.scope };
    case 'conditionChanged': {
      const current = action.scope === 'thread' ? state.conditions : state.savedConditions;
      const next = { ...current, ...action.changes };
      if (action.scope === 'saved') return { ...state, savedConditions: next };
      const activePreferenceLabels = new Set(preferenceChipLabels(next));
      const removedChipLabels = state.removedChipLabels.filter(
        (label) => !activePreferenceLabels.has(label),
      );
      return {
        ...state,
        conditions: next,
        chips: mergeChipLabels(preferenceChipLabels(next), state.query, removedChipLabels),
        removedChipLabels,
      };
    }
    case 'decided':
      return hasCandidate(state, action.candidateId, action.responseState)
        ? { ...state, phase: 'decided', selectedCandidateId: action.candidateId }
        : state;
    case 'toggleDrawer':
      return { ...state, drawerOpen: !state.drawerOpen };
    case 'closeDrawer':
      return { ...state, drawerOpen: false };
    case 'setDrawerView':
      return { ...state, drawerView: action.view };
    case 'reset':
      return createJourneyShellState(state.responseState.threadId, state.savedConditions);
  }
};
