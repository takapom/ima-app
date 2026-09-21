import { describe, expect, it } from 'vitest';
import {
  projectConversationMemory,
  type ConversationMemory,
} from '@worker/application/model-context/conversation-memory';

const memory: ConversationMemory = {
  ownerScopeRef: 'owner-a',
  conversationId: 'conversation-a',
  beforeSequence: 3,
  entries: [
    {
      messageId: 'user-a',
      sequence: 1,
      role: 'user',
      text: '静かなカフェが好き',
      sourceThreadId: null,
      expiresAt: null,
    },
    {
      messageId: 'assistant-a',
      sequence: 2,
      role: 'assistant',
      text: '前日の回答',
      sourceThreadId: 'old-thread',
      expiresAt: '2026-09-21T11:00:00Z',
    },
  ],
};
describe('conversation memory projection', () => {
  it('keeps user speech across sessions, expires assistant text, and strips owner identity', () => {
    const result = projectConversationMemory(memory, 'owner-a', '2026-09-22T10:00:00Z');
    expect(result.entries).toEqual([memory.entries[0]]);
    expect(result).not.toHaveProperty('ownerScopeRef');
    expect(result.entries[0]).not.toHaveProperty('evidenceIds');
  });
  it('rejects another owner and inclusion of the current input or a later message', () => {
    expect(() => projectConversationMemory(memory, 'owner-b', '2026-09-21T10:00:00Z')).toThrow();
    expect(() =>
      projectConversationMemory(
        { ...memory, beforeSequence: 2 },
        'owner-a',
        '2026-09-21T10:00:00Z',
      ),
    ).toThrow();
  });
});
