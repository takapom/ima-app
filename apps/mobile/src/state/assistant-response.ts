import type { AssistantResponse, CardsData, PublicMessage } from '@ima/contracts';

export type AssistantResponseState = {
  readonly threadId: string;
  readonly revision: number;
  readonly appliedResponseIds: readonly string[];
  readonly restoredResponseIds: readonly string[];
  readonly restoreStatuses: readonly RestoreStatus[];
  readonly messages: readonly PublicMessage[];
  readonly cardSetId: string | null;
  readonly cards: CardsData | null;
};

export type RestoreStatus = {
  readonly responseId: AssistantResponse['responseId'];
  readonly revision: AssistantResponse['revision'];
  readonly kind: AssistantResponse['kind'];
  readonly cardSetId: AssistantResponse['cardSetId'];
  readonly restoreMode: 'reference_only' | 'unavailable';
  readonly payloadAvailable: false;
};

export type RestoredResponseReference = {
  readonly responseId: AssistantResponse['responseId'];
  readonly revision: AssistantResponse['revision'];
  readonly kind: AssistantResponse['kind'];
  readonly cardSetId: AssistantResponse['cardSetId'];
  readonly threadId: AssistantResponse['threadId'];
  readonly restoreMode: 'reference_only' | 'unavailable';
};

export const createAssistantResponseState = (threadId: string): AssistantResponseState => ({
  threadId,
  revision: 0,
  appliedResponseIds: [],
  restoredResponseIds: [],
  restoreStatuses: [],
  messages: [],
  cardSetId: null,
  cards: null,
});

const hasSeenResponse = (state: AssistantResponseState, responseId: string) =>
  state.appliedResponseIds.includes(responseId) || state.restoredResponseIds.includes(responseId);

export const applyAssistantResponse = (
  state: AssistantResponseState,
  response: AssistantResponse,
): AssistantResponseState => {
  if (
    response.threadId !== state.threadId ||
    hasSeenResponse(state, response.responseId) ||
    response.revision <= state.revision
  ) {
    return state;
  }

  const next = {
    ...state,
    revision: response.revision,
    appliedResponseIds: [...state.appliedResponseIds, response.responseId],
    messages: [...state.messages, ...response.message],
  };

  if (response.kind === 'message') {
    return {
      ...next,
      cardSetId: state.cardSetId,
      cards: state.cards,
    };
  }

  return {
    ...next,
    cardSetId: response.cardSetId,
    cards: response.cards,
  };
};

export const acknowledgeRestoredResponse = (
  state: AssistantResponseState,
  reference: RestoredResponseReference,
): AssistantResponseState => {
  if (
    reference.threadId !== state.threadId ||
    hasSeenResponse(state, reference.responseId) ||
    reference.revision <= state.revision
  ) {
    return state;
  }

  return {
    ...state,
    revision: Math.max(state.revision, reference.revision),
    restoredResponseIds: [...state.restoredResponseIds, reference.responseId],
    restoreStatuses: [
      ...state.restoreStatuses,
      {
        ...reference,
        payloadAvailable: false,
      },
    ],
    ...(reference.kind === 'cards' ? { cardSetId: null, cards: null } : {}),
  };
};

export const advanceAssistantRevision = (
  state: AssistantResponseState,
  revision: number,
): AssistantResponseState => (revision > state.revision ? { ...state, revision } : state);
