import { describe, expect, it } from 'vitest';
import type { ConversationMessage, PublicMessage } from '@ima/contracts';
import {
  conversationTranscriptParts,
  conversationTranscriptEntries,
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
  basis: 'conversational',
  evidence: [],
  evidenceIds: [],
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
