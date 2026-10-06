import type { AssistantResponse, CardsData, PublicMessage } from '@ima/contracts';

export type AssistantResponseState = {
  readonly threadId: string;
  readonly revision: number;
  readonly appliedResponseIds: readonly string[];
  readonly restoredResponseIds: readonly string[];
  readonly restoreStatuses: readonly RestoreStatus[];
  readonly responseRecords: readonly AssistantResponseRecord[];
  /** The current card payload is the only in-state source for rendered cards. */
  readonly cardSetId: string | null;
  readonly cards: CardsData | null;
  readonly cardSetDisplay: CardSetDisplayState;
};

export type AssistantResponseRecord = {
  readonly responseId: AssistantResponse['responseId'];
  readonly turnId: AssistantResponse['turnId'];
  readonly revision: AssistantResponse['revision'];
  readonly kind: AssistantResponse['kind'];
  readonly presentation: AssistantResponse['presentation'];
  /** The identifier declared by the response payload, before keep semantics. */
  readonly declaredCardSetId: AssistantResponse['cardSetId'];
  /** The card set this response's message is associated with for display. */
  readonly effectiveCardSetId: AssistantResponse['cardSetId'];
  readonly messages: readonly PublicMessage[];
  /** Present only when the worker reported that this reply's turn searched and found nothing. */
  readonly foundNothing?: true;
};

export type AssistantMessageRecord = {
  readonly responseId: AssistantResponse['responseId'];
  readonly turnId: AssistantResponse['turnId'];
  readonly revision: AssistantResponse['revision'];
  /** The identifier declared by the response payload. */
  readonly declaredCardSetId: AssistantResponse['cardSetId'];
  /** The card set actually visible when this message was applied. */
  readonly cardSetId: AssistantResponse['cardSetId'];
  readonly message: PublicMessage;
};

export type CardSetDisplayState =
  | {
      readonly kind: 'empty';
      readonly reason: 'initial' | 'no_cards' | 'reference_only' | 'unavailable';
      readonly responseId: AssistantResponse['responseId'] | null;
    }
  | {
      readonly kind: 'available';
      readonly responseId: AssistantResponse['responseId'];
      readonly sourceRevision: AssistantResponse['revision'];
    }
  | {
      readonly kind: 'kept';
      /** The response that is currently explaining the retained card set. */
      readonly responseId: AssistantResponse['responseId'];
      /** The response that supplied the retained card payload. */
      readonly sourceResponseId: AssistantResponse['responseId'];
      readonly sourceRevision: AssistantResponse['revision'];
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
  responseRecords: [],
  cardSetId: null,
  cards: null,
  cardSetDisplay: {
    kind: 'empty',
    reason: 'initial',
    responseId: null,
  },
});

export const selectAssistantMessages = (state: AssistantResponseState): readonly PublicMessage[] =>
  state.responseRecords.flatMap((record) => record.messages);

/** Only the latest reply counts; a later reply with cards or a question clears it. */
export const selectLatestReplyFoundNothing = (state: AssistantResponseState): boolean =>
  state.responseRecords.at(-1)?.foundNothing === true;

export const selectAssistantMessageRecords = (
  state: AssistantResponseState,
): readonly AssistantMessageRecord[] =>
  state.responseRecords.flatMap((record) =>
    record.messages.map((message) => ({
      responseId: record.responseId,
      turnId: record.turnId,
      revision: record.revision,
      declaredCardSetId: record.declaredCardSetId,
      cardSetId: record.effectiveCardSetId,
      message,
    })),
  );

const hasSeenResponse = (state: AssistantResponseState, responseId: string) =>
  state.appliedResponseIds.includes(responseId) || state.restoredResponseIds.includes(responseId);

const currentCardSetSource = (
  state: AssistantResponseState,
): {
  responseId: AssistantResponse['responseId'];
  revision: AssistantResponse['revision'];
} | null => {
  if (state.cardSetDisplay.kind === 'available') {
    return {
      responseId: state.cardSetDisplay.responseId,
      revision: state.cardSetDisplay.sourceRevision,
    };
  }
  if (state.cardSetDisplay.kind === 'kept') {
    return {
      responseId: state.cardSetDisplay.sourceResponseId,
      revision: state.cardSetDisplay.sourceRevision,
    };
  }
  return null;
};

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

  const effectiveCardSetId =
    response.kind === 'cards'
      ? response.cardSetId
      : state.cards === null
        ? response.cardSetId
        : state.cardSetId;
  const responseRecord: AssistantResponseRecord = {
    responseId: response.responseId,
    turnId: response.turnId,
    revision: response.revision,
    kind: response.kind,
    presentation: response.presentation,
    declaredCardSetId: response.cardSetId,
    effectiveCardSetId,
    messages: response.message,
    ...(response.kind === 'message' && response.searchOutcome === 'no_candidates'
      ? { foundNothing: true as const }
      : {}),
  };

  const next = {
    ...state,
    revision: response.revision,
    appliedResponseIds: [...state.appliedResponseIds, response.responseId],
    responseRecords: [...state.responseRecords, responseRecord],
  };

  if (response.kind === 'message') {
    if (state.cards !== null && state.cardSetId !== null) {
      const source = currentCardSetSource(state);
      if (source !== null) {
        return {
          ...next,
          cardSetId: state.cardSetId,
          cards: state.cards,
          cardSetDisplay: {
            kind: 'kept',
            responseId: response.responseId,
            sourceResponseId: source.responseId,
            sourceRevision: source.revision,
          },
        };
      }
    }
    return {
      ...next,
      cardSetId: null,
      cards: null,
      cardSetDisplay: {
        kind: 'empty',
        reason: 'no_cards',
        responseId: response.responseId,
      },
    };
  }

  return {
    ...next,
    cardSetId: response.cardSetId,
    cards: response.cards,
    cardSetDisplay: {
      kind: 'available',
      responseId: response.responseId,
      sourceRevision: response.revision,
    },
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
    ...(reference.kind === 'cards'
      ? {
          cardSetId: null,
          cards: null,
          cardSetDisplay: {
            kind: 'empty' as const,
            reason: reference.restoreMode,
            responseId: reference.responseId,
          },
        }
      : state.cards !== null && state.cardSetId !== null
        ? (() => {
            const source = currentCardSetSource(state);
            return source === null
              ? {}
              : {
                  cardSetDisplay: {
                    kind: 'kept' as const,
                    responseId: reference.responseId,
                    sourceResponseId: source.responseId,
                    sourceRevision: source.revision,
                  },
                };
          })()
        : {}),
  };
};

export const advanceAssistantRevision = (
  state: AssistantResponseState,
  revision: number,
): AssistantResponseState => (revision > state.revision ? { ...state, revision } : state);
