import { createAssistantResponseState, type AssistantResponseState } from './assistant-response';

export type JourneyPhase = 'empty' | 'working' | 'results' | 'decided' | 'error';

export type DrawerView = 'home' | 'history' | 'saved';

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
  readonly query: string;
  readonly draft: string;
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
  | {
      readonly type: 'decided';
      readonly candidateId: string;
      readonly responseState?: AssistantResponseState;
    }
  | { readonly type: 'toggleDrawer' }
  | { readonly type: 'closeDrawer' }
  | { readonly type: 'setDrawerView'; readonly view: DrawerView }
  | { readonly type: 'reset' };

export const createJourneyShellState = (threadId: string): JourneyShellState => ({
  phase: 'empty',
  query: '',
  draft: '',
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
            query: action.query,
            selectedCandidateId: null,
            errorMessage: null,
            drawerOpen: false,
          };
    }
    case 'responseApplied':
      return {
        ...state,
        responseState: action.responseState,
        phase: action.responseState.revision > 0 ? 'results' : state.phase,
        draft: action.responseState.revision > 0 ? '' : state.draft,
        errorMessage: null,
      };
    case 'requestFailed':
      return { ...state, phase: 'error', errorMessage: action.message };
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
      return createJourneyShellState(state.responseState.threadId);
  }
};
