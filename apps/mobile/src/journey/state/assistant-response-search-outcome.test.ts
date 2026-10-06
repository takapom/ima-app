import { describe, expect, it } from 'vitest';
import type { AssistantMessageResponse } from '@ima/contracts';
import {
  applyAssistantResponse,
  createAssistantResponseState,
  selectLatestReplyFoundNothing,
} from '@mobile/journey/state/assistant-response';

const reply = (revision: number, searchOutcome?: 'no_candidates'): AssistantMessageResponse => ({
  schemaVersion: 'v1',
  threadId: 'thread-1',
  turnId: `turn-${revision}`,
  responseId: `response-${revision}`,
  revision,
  kind: 'message',
  presentation: 'keep',
  cardSetId: null,
  message: [
    {
      text: '近くに見つかりませんでした',
      retention: {
        retentionDecision: 'deny',
        retentionMode: 'session_only',
        sessionExpiresAt: '2026-09-09T13:00:00Z',
        freshUntil: '2026-09-09T13:00:00Z',
        displayUntil: '2026-09-09T13:00:00Z',
        retentionUntil: null,
        deletionScheduledAt: null,
        attribution: null,
        restoreMode: 'reference_only',
        policyStatus: 'policy_withheld',
        displayPolicyStatus: 'available',
      },
    },
  ],
  ...(searchOutcome === undefined ? {} : { searchOutcome }),
});

describe('latest reply search outcome', () => {
  it('is false before any reply', () => {
    expect(selectLatestReplyFoundNothing(createAssistantResponseState('thread-1'))).toBe(false);
  });

  it('is true when the latest reply says its search found no candidates', () => {
    const state = applyAssistantResponse(
      createAssistantResponseState('thread-1'),
      reply(1, 'no_candidates'),
    );
    expect(selectLatestReplyFoundNothing(state)).toBe(true);
  });

  it('follows only the latest reply', () => {
    const first = applyAssistantResponse(
      createAssistantResponseState('thread-1'),
      reply(1, 'no_candidates'),
    );
    expect(selectLatestReplyFoundNothing(applyAssistantResponse(first, reply(2)))).toBe(false);
  });
});
