import { describe, expect, it } from 'vitest';
import type { ConversationMessage, PublicMessage } from '@ima/contracts';
import {
  conversationTranscriptParts,
  conversationTranscriptEntries,
  foldsExplanation,
} from '@mobile/journey/services/conversations/conversation-transcript';
const saved: ConversationMessage = {
  conversationId: 'conversation',
  sequence: 2,
  createdAt: '2026-09-21T10:00:00Z',
  message: {
    messageId: 'message',
    role: 'assistant',
    source: { threadId: 'thread', turnId: 'turn', responseId: 'response' },
    parts: [{ kind: 'unavailable', reason: 'policy_withheld' }],
  },
};
const message: PublicMessage = {
  text: 'その場で表示できる回答',
  retention: {
    retentionDecision: 'deny',
    retentionMode: 'session_only',
    sessionExpiresAt: '2026-09-21T11:00:00Z',
    freshUntil: null,
    displayUntil: '2026-09-21T11:00:00Z',
    retentionUntil: null,
    deletionScheduledAt: null,
    attribution: null,
    restoreMode: 'reference_only',
    policyStatus: 'policy_withheld',
    displayPolicyStatus: 'available',
  },
};
describe('conversation display projection', () => {
  it('preserves card snapshots when live text overlays the saved answer', () => {
    const card = {
      kind: 'card_set' as const,
      threadId: 'thread',
      cardSetId: 'cards',
      revision: 2,
      photosExpireAt: null,
      cards: {
        hero: {
          candidateId: 'shop',
          facts: { identity: { status: 'unknown' as const, reason: '期限切れ' } },
          why: message,
        },
        alts: [],
      },
    };
    const record = {
      ...saved,
      message: { ...saved.message, parts: [...saved.message.parts, card] },
    };
    const live = {
      responseId: 'response',
      turnId: 'turn',
      revision: 2,
      declaredCardSetId: 'cards',
      cardSetId: 'cards',
      message,
    };
    expect(conversationTranscriptParts(record, [live])).toEqual([
      { kind: 'retained_text', text: message.text, retention: message.retention },
      card,
    ]);
    expect(conversationTranscriptEntries([record], [], null)[0]?.parts).toContainEqual(card);
  });
  it('shows unsynced current-turn text once, never persists it, and excludes expired or other-turn text', () => {
    const live = {
      responseId: 'response',
      turnId: 'turn',
      revision: 2,
      declaredCardSetId: null,
      cardSetId: null,
      message,
    };
    expect(conversationTranscriptEntries([], [live], 'turn')).toMatchObject([
      { role: 'assistant', parts: [{ text: message.text }] },
    ]);
    expect(conversationTranscriptEntries([saved], [live], 'turn')).toHaveLength(1);
    expect(conversationTranscriptEntries([], [live], 'another-turn')).toEqual([]);
    expect(
      conversationTranscriptEntries(
        [],
        [
          {
            ...live,
            message: {
              ...message,
              retention: { ...message.retention, displayPolicyStatus: 'expired' },
            },
          },
        ],
        'turn',
      ),
    ).toEqual([]);
    expect(saved.message.parts).toEqual([{ kind: 'unavailable', reason: 'policy_withheld' }]);
  });
  it('shows a projected live answer without mutating its non-persistable history record', () => {
    const live = {
      responseId: 'response',
      turnId: 'turn',
      revision: 2,
      declaredCardSetId: null,
      cardSetId: null,
      message,
    };
    expect(conversationTranscriptParts(saved, [live])[0]).toMatchObject({ text: message.text });
    expect(
      conversationTranscriptParts(saved, [
        {
          ...live,
          message: {
            ...message,
            retention: { ...message.retention, displayPolicyStatus: 'expired' },
          },
        },
      ]),
    ).toEqual(saved.message.parts);
    expect(saved.message.parts).toEqual([{ kind: 'unavailable', reason: 'policy_withheld' }]);
    expect(conversationTranscriptParts(saved, [])).toEqual(saved.message.parts);
    expect(conversationTranscriptParts(saved, [{ ...live, responseId: 'other' }])).toEqual(
      saved.message.parts,
    );
  });
});

describe('folded explanation', () => {
  const text = { kind: 'retained_text' as const, text: message.text, retention: message.retention };
  const cardSet = {
    kind: 'card_set' as const,
    threadId: 'thread',
    cardSetId: 'cards',
    revision: 2,
    photosExpireAt: null,
    cards: {
      hero: {
        candidateId: 'shop',
        facts: { identity: { status: 'unknown' as const, reason: 'fixture' } },
        why: message,
      },
      alts: [],
    },
  };

  it('folds what ima. wrote when the answer came with cards', () => {
    expect(foldsExplanation({ role: 'assistant', parts: [text, text, cardSet] })).toBe(true);
  });

  it('keeps a question or an answer without cards open', () => {
    expect(foldsExplanation({ role: 'assistant', parts: [text] })).toBe(false);
  });

  it('keeps the text open when the cards of that answer were not saved', () => {
    expect(
      foldsExplanation({
        role: 'assistant',
        parts: [text, { kind: 'card_set_reference', threadId: 'thread', cardSetId: 'cards' }],
      }),
    ).toBe(false);
  });

  it('has nothing to fold without text, and never folds what the user wrote', () => {
    expect(foldsExplanation({ role: 'assistant', parts: [cardSet] })).toBe(false);
    expect(
      foldsExplanation({ role: 'user', parts: [{ kind: 'user_text', text: '恵比寿でカフェ' }] }),
    ).toBe(false);
  });
});
