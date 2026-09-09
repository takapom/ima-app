import { describe, expect, it } from 'vitest';
import type { AssistantCardsResponse, AssistantMessageResponse } from '@ima/contracts';
import {
  acknowledgeRestoredResponse,
  applyAssistantResponse,
  createAssistantResponseState,
} from './assistant-response';
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
    expect(withMessage.messages).toHaveLength(2);
  });

  it('ignores duplicate response IDs and older revisions', () => {
    const applied = applyAssistantResponse(
      applyAssistantResponse(initialState, messageResponse(2, 'response-2')),
      messageResponse(2, 'response-2'),
    );
    const older = applyAssistantResponse(applied, messageResponse(1, 'response-1'));

    expect(older).toBe(applied);
    expect(older.messages).toHaveLength(1);
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
    expect(state.messages).toHaveLength(0);
    expect(state.restoredResponseIds).toEqual(['response-reference']);
    expect(state.restoreStatuses[0]).toMatchObject({
      responseId: 'response-reference',
      restoreMode: 'reference_only',
      payloadAvailable: false,
    });
    expect(state.revision).toBe(4);
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
    expect(lateFull).toBe(restored);
  });
});
