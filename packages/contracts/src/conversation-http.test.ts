import { describe, expect, it } from 'vitest';
import {
  parseConversationMessage,
  parseConversationRunResponse,
} from '@contracts/conversation-http';
import { RouteContracts } from '@contracts/http';

const now = '2026-09-21T10:00:00Z';
describe('conversation HTTP contracts', () => {
  it('rejects assistant text disguised as user-owned indefinite storage', () => {
    const record = {
      conversationId: 'conversation',
      sequence: 1,
      createdAt: now,
      message: {
        messageId: 'message',
        role: 'user',
        source: null,
        parts: [{ kind: 'user_text', text: 'こんにちは' }],
      },
    };
    expect(parseConversationMessage(record).success).toBe(true);
    expect(
      parseConversationMessage({ ...record, message: { ...record.message, role: 'assistant' } })
        .success,
    ).toBe(false);
    expect(
      parseConversationMessage({
        ...record,
        message: {
          ...record.message,
          source: { threadId: 'thread', turnId: 'turn', responseId: 'response' },
        },
      }).success,
    ).toBe(false);
  });
  it('rejects completed runs without answers and mismatched conversation scope', () => {
    const value = {
      schemaVersion: 'v1',
      requestId: 'request',
      response: null,
      conversation: {
        conversationId: 'conversation',
        title: '会話',
        revision: 2,
        lastSequence: 1,
        createdAt: now,
        updatedAt: now,
      },
      run: {
        conversationId: 'conversation',
        runId: 'run',
        userMessageId: 'user',
        inputSequence: 1,
        status: 'accepted',
        createdAt: now,
        updatedAt: now,
        threadId: null,
        turnId: null,
        assistantMessageId: null,
        failure: null,
      },
    };
    expect(parseConversationRunResponse(value).success).toBe(true);
    expect(
      parseConversationRunResponse({ ...value, run: { ...value.run, status: 'completed' } })
        .success,
    ).toBe(false);
    expect(
      parseConversationRunResponse({ ...value, run: { ...value.run, conversationId: 'other' } })
        .success,
    ).toBe(false);
    expect(RouteContracts.conversationTurn.successStatus).toBe(202);
    expect(RouteContracts.conversationEvents.path).toBe(
      '/v1/conversations/:conversationId/runs/:runId/events',
    );
  });
});
