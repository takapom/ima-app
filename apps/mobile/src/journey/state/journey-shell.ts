import {
  conditionChangesForChip,
  createDefaultJourneyConditions,
  preferenceChipLabels,
  type ConditionScope,
  type JourneyConditions,
} from '@mobile/preferences/state/conditions';
import { mergeChipLabels } from '@mobile/journey/state/journey-input';

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
  readonly settingsOpen: boolean;
  readonly errorMessage: string | null;
};

export type JourneyShellAction =
  | { readonly type: 'draftChanged'; readonly value: string }
  | { readonly type: 'beginRequest'; readonly query: string }
  | { readonly type: 'responseSettled' }
  | { readonly type: 'requestFailed'; readonly message: string }
  | { readonly type: 'cancelRequest' }
  | { readonly type: 'chipRemoved'; readonly label: string }
  | { readonly type: 'conditionScopeChanged'; readonly scope: ConditionScope }
  | {
      readonly type: 'conditionChanged';
      readonly scope: ConditionScope;
      readonly changes: Partial<JourneyConditions>;
    }
  | { readonly type: 'decided' }
  | { readonly type: 'toggleDrawer' }
  | { readonly type: 'closeDrawer' }
  | { readonly type: 'setDrawerView'; readonly view: DrawerView }
  | { readonly type: 'openSettings' }
  | { readonly type: 'closeSettings' }
  | { readonly type: 'reset' };

export const createJourneyShellState = (
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
  settingsOpen: false,
  errorMessage: null,
});

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
            errorMessage: null,
            drawerOpen: false,
          };
    }
    case 'responseSettled':
      return state.requestState === 'pending'
        ? { ...state, requestState: 'idle', phase: 'results', errorMessage: null }
        : state;
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
      return { ...state, phase: 'decided' };
    case 'toggleDrawer':
      return { ...state, drawerOpen: !state.drawerOpen };
    case 'closeDrawer':
      return { ...state, drawerOpen: false };
    case 'setDrawerView':
      return { ...state, drawerView: action.view };
    // 設定はDrawerからの行き先。全画面が覆うため、戻り先はDrawerではなく会話にする。
    case 'openSettings':
      return { ...state, settingsOpen: true, drawerOpen: false };
    case 'closeSettings':
      return { ...state, settingsOpen: false };
    case 'reset':
      return createJourneyShellState(state.savedConditions);
  }
};
