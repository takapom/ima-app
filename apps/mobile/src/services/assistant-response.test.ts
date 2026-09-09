import { describe, expect, it } from 'vitest';
import { applySearchResponseJson, applyThreadSnapshotJson } from './assistant-response';
import { createAssistantResponseState } from '../state/assistant-response';
const initialState = createAssistantResponseState('thread-1');

const retention = {
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
};
const persistedRetention = {
  retentionDecision: 'allow' as const,
  retentionMode: 'provider_limited' as const,
  sessionExpiresAt: '2026-09-10T05:00:00+09:00',
  freshUntil: '2026-09-09T12:00:00Z',
  displayUntil: '2026-09-09T13:00:00Z',
  retentionUntil: '2026-09-10T05:00:00+09:00',
  deletionScheduledAt: '2026-09-10T05:00:00+09:00',
  attribution: null,
  restoreMode: 'full' as const,
  policyStatus: 'available' as const,
  displayPolicyStatus: 'available' as const,
};

const message = {
  text: '確認しました',
  evidenceIds: [],
  evidence: [],
  basis: 'conversational' as const,
  retention,
};
const persistedMessage = { ...message, retention: persistedRetention };
type ResponseMessage = typeof message | typeof persistedMessage;

const response = (
  revision: number,
  responseId: string,
  responseMessage: ResponseMessage = message,
) => ({
  schemaVersion: 'v1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  responseId,
  revision,
  kind: 'message',
  presentation: 'keep',
  cardSetId: null,
  message: [responseMessage],
});

const fullRecord = (
  revision: number,
  responseId: string,
  responseMessage: ResponseMessage = persistedMessage,
) => {
  const source = response(revision, responseId, responseMessage);
  return {
    turnId: source.turnId,
    responseId: source.responseId,
    revision: source.revision,
    kind: source.kind,
    presentation: source.presentation,
    cardSetId: source.cardSetId,
    message: source.message,
    restoreMode: 'full' as const,
  };
};

describe('M04 assistant response fixture (independent of M05 runtime)', () => {
  it('parses an unknown search payload through contracts before applying it', () => {
    const result = applySearchResponseJson(initialState, {
      requestId: 'request-1',
      response: response(1, 'response-1'),
      warnings: [],
    });

    expect(result.accepted).toBe(true);
    expect(result.state.appliedResponseIds).toEqual(['response-1']);
    expect(result.state.messages).toHaveLength(1);
  });

  it('rejects unknown JSON without mutating state', () => {
    const result = applySearchResponseJson(initialState, {
      requestId: 'request-1',
      response: { ...response(1, 'response-1'), unexpected: true },
      warnings: [],
    });

    expect(result.accepted).toBe(false);
    expect(result.state).toBe(initialState);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('does not restore message or card payload for reference-only records', () => {
    const result = applyThreadSnapshotJson(initialState, {
      schemaVersion: 'v1',
      requestId: 'request-1',
      threadId: 'thread-1',
      revision: 3,
      active: true,
      responses: [
        {
          turnId: 'turn-1',
          responseId: 'response-reference',
          revision: 3,
          kind: 'message',
          presentation: 'keep',
          cardSetId: null,
          restoreMode: 'reference_only',
        },
      ],
    });

    expect(result.accepted).toBe(true);
    expect(result.state.messages).toHaveLength(0);
    expect(result.state.cards).toBeNull();
    expect(result.state.restoreStatuses).toMatchObject([
      { responseId: 'response-reference', restoreMode: 'reference_only', payloadAvailable: false },
    ]);
    expect(result.state.revision).toBe(3);
  });

  it('rejects a full snapshot containing retention-denied text', () => {
    const result = applyThreadSnapshotJson(initialState, {
      schemaVersion: 'v1',
      requestId: 'request-1',
      threadId: 'thread-1',
      revision: 1,
      active: true,
      responses: [fullRecord(1, 'response-denied', message)],
    });

    expect(result.accepted).toBe(false);
    expect(result.state).toBe(initialState);
  });

  it('sorts snapshot records by revision before applying them', () => {
    const result = applyThreadSnapshotJson(initialState, {
      schemaVersion: 'v1',
      requestId: 'request-1',
      threadId: 'thread-1',
      revision: 2,
      active: true,
      responses: [fullRecord(2, 'response-2'), fullRecord(1, 'response-1')],
    });

    expect(result.accepted).toBe(true);
    expect(result.state.appliedResponseIds).toEqual(['response-1', 'response-2']);
    expect(result.state.messages).toHaveLength(2);
    expect(result.state.revision).toBe(2);
  });

  it('rejects a snapshot with two response IDs at one revision', () => {
    const result = applyThreadSnapshotJson(initialState, {
      schemaVersion: 'v1',
      requestId: 'request-1',
      threadId: 'thread-1',
      revision: 1,
      active: true,
      responses: [fullRecord(1, 'response-1'), fullRecord(1, 'response-2')],
    });

    expect(result.accepted).toBe(false);
    expect(result.state).toBe(initialState);
  });

  it('rejects another thread without applying its response', () => {
    const result = applySearchResponseJson(initialState, {
      requestId: 'request-1',
      response: { ...response(1, 'other-thread-response'), threadId: 'thread-2' },
      warnings: [],
    });

    expect(result.accepted).toBe(false);
    expect(result.state).toBe(initialState);
    expect(result.issues[0]).toContain('does not match state thread');
  });
});
