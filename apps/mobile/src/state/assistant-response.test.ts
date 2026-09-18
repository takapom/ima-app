import { describe, expect, it } from 'vitest';
import type { AssistantCardsResponse, AssistantMessageResponse } from '@ima/contracts';
import {
  acknowledgeRestoredResponse,
  applyAssistantResponse,
  createAssistantResponseState,
  selectAssistantMessageRecords,
  selectAssistantMessages,
} from '@mobile/state/assistant-response';
const initialState = createAssistantResponseState('thread-1');

const message = {
  text: '候補を確認しました',
  evidenceIds: [],
  evidence: [],
  basis: 'conversational' as const,
  retention: {
    retentionDecision: 'deny' as const,
    retentionMode: 'session_only' as const,
    sessionExpiresAt: '2026-09-09T13:00:00Z',
    freshUntil: '2026-09-09T13:00:00Z',
    displayUntil: '2026-09-09T13:00:00Z',
    retentionUntil: null,
    deletionScheduledAt: null,
    attribution: null,
    restoreMode: 'reference_only' as const,
    policyStatus: 'policy_withheld' as const,
    displayPolicyStatus: 'available' as const,
  },
};

const messageResponse = (revision: number, responseId: string): AssistantMessageResponse => ({
  schemaVersion: 'v1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  responseId,
  revision,
  kind: 'message',
  presentation: 'keep',
  cardSetId: null,
  message: [message],
});

const cardsResponse: AssistantCardsResponse = {
  ...messageResponse(2, 'response-2'),
  kind: 'cards',
  presentation: 'replace',
  cardSetId: 'cards-2',
  cards: {
    hero: {
      candidateId: 'candidate-1',
      facts: {
        identity: {
          status: 'known',
          value: {
            name: 'Melt',
            area: '恵比寿',
            address: null,
            category: 'cafe',
            stationName: null,
            accessText: null,
            businessStatus: 'operational',
            sourceUrl: 'https://example.com/place',
          },
          evidence: [],
        },
      },
      why: message,
    },
    alts: [],
  },
};

describe('assistant response state', () => {
  it('keeps cards for message responses and replaces them for cards responses', () => {
    const withCards = applyAssistantResponse(initialState, cardsResponse);
    const withMessage = applyAssistantResponse(withCards, {
      ...messageResponse(3, 'response-3'),
      cardSetId: 'cards-from-message',
    });

    expect(withMessage.cards).toBe(cardsResponse.cards);
    expect(withMessage.cardSetId).toBe('cards-2');
    expect(selectAssistantMessages(withMessage)).toHaveLength(2);
    expect(selectAssistantMessageRecords(withMessage)[1]).toMatchObject({
      responseId: 'response-3',
      declaredCardSetId: 'cards-from-message',
      cardSetId: 'cards-2',
    });
    expect(withMessage.responseRecords[1]).toMatchObject({
      responseId: 'response-3',
      declaredCardSetId: 'cards-from-message',
      effectiveCardSetId: 'cards-2',
    });
    expect(withMessage.cardSetDisplay).toMatchObject({
      kind: 'kept',
      responseId: 'response-3',
      sourceResponseId: 'response-2',
      sourceRevision: 2,
    });
  });

  it('represents a message response without an existing card set as an empty result', () => {
    const state = applyAssistantResponse(initialState, messageResponse(1, 'message-only'));

    expect(state.cardSetDisplay).toEqual({
      kind: 'empty',
      reason: 'no_cards',
      responseId: 'message-only',
    });
    expect(state.cards).toBeNull();
    expect(selectAssistantMessageRecords(state)[0]).toMatchObject({
      responseId: 'message-only',
      cardSetId: null,
    });
  });

  it('replaces the display state when a later card response arrives', () => {
    const first = applyAssistantResponse(initialState, cardsResponse);
    const secondCards: AssistantCardsResponse = {
      ...cardsResponse,
      responseId: 'response-4',
      revision: 4,
      cardSetId: 'cards-4',
    };

    const next = applyAssistantResponse(first, secondCards);

    expect(next.cardSetDisplay).toMatchObject({
      kind: 'available',
      responseId: 'response-4',
      sourceRevision: 4,
    });
    expect(next.cardSetDisplay).not.toBe(first.cardSetDisplay);
    expect(selectAssistantMessageRecords(next)[1]?.cardSetId).toBe('cards-4');
  });

  it('ignores duplicate response IDs and older revisions', () => {
    const applied = applyAssistantResponse(
      applyAssistantResponse(initialState, messageResponse(2, 'response-2')),
      messageResponse(2, 'response-2'),
    );
    const older = applyAssistantResponse(applied, messageResponse(1, 'response-1'));

    expect(older).toBe(applied);
    expect(selectAssistantMessages(older)).toHaveLength(1);
    expect(older.responseRecords).toHaveLength(1);
    expect(selectAssistantMessageRecords(older)).toHaveLength(1);
  });

  it('acknowledges a restore reference without reconstructing payload', () => {
    const state = acknowledgeRestoredResponse(initialState, {
      responseId: 'response-reference',
      revision: 4,
      kind: 'cards',
      cardSetId: 'cards-reference',
      threadId: 'thread-1',
      restoreMode: 'reference_only',
    });

    expect(state.cards).toBeNull();
    expect(selectAssistantMessages(state)).toHaveLength(0);
    expect(state.restoredResponseIds).toEqual(['response-reference']);
    expect(state.cardSetDisplay).toEqual({
      kind: 'empty',
      reason: 'reference_only',
      responseId: 'response-reference',
    });
    expect(state.restoreStatuses[0]).toMatchObject({
      responseId: 'response-reference',
      restoreMode: 'reference_only',
      payloadAvailable: false,
    });
    expect(state.revision).toBe(4);
  });

  it('marks a restored message reference as kept context when cards already exist', () => {
    const withCards = applyAssistantResponse(initialState, cardsResponse);
    const restored = acknowledgeRestoredResponse(withCards, {
      responseId: 'message-reference',
      revision: 3,
      kind: 'message',
      cardSetId: null,
      threadId: 'thread-1',
      restoreMode: 'reference_only',
    });

    expect(restored.cards).toBe(cardsResponse.cards);
    expect(restored.cardSetId).toBe('cards-2');
    expect(restored.cardSetDisplay).toEqual({
      kind: 'kept',
      responseId: 'message-reference',
      sourceResponseId: 'response-2',
      sourceRevision: 2,
    });
    expect(selectAssistantMessages(restored)).toHaveLength(1);
  });

  it('rejects a response from another thread at the state boundary', () => {
    const otherThread = applyAssistantResponse(initialState, {
      ...messageResponse(1, 'other-thread-response'),
      threadId: 'thread-2',
    });

    expect(otherThread).toBe(initialState);
  });

  it('clears stale cards and rejects a late full payload after restore', () => {
    const withCards = applyAssistantResponse(initialState, cardsResponse);
    const restored = acknowledgeRestoredResponse(withCards, {
      responseId: 'response-lost',
      revision: 3,
      kind: 'cards',
      cardSetId: 'cards-lost',
      threadId: 'thread-1',
      restoreMode: 'unavailable',
    });
    const lateFull = applyAssistantResponse(restored, {
      ...cardsResponse,
      responseId: 'response-lost',
      revision: 4,
    });

    expect(restored.cards).toBeNull();
    expect(restored.cardSetId).toBeNull();
    expect(restored.cardSetDisplay).toEqual({
      kind: 'empty',
      reason: 'unavailable',
      responseId: 'response-lost',
    });
    expect(lateFull).toBe(restored);
  });
});
