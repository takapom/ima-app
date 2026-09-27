import { describe, expect, it, vi } from 'vitest';
import type { AssistantResponse, ConversationRunResponse } from '@ima/contracts';
import type { ConversationClient } from '@mobile/platform/http/conversation-client';
import type { ApiResult } from '@mobile/platform/http/api';
import { ConversationController } from '@mobile/journey/services/conversations/conversation-controller';
import { conversationTranscriptEntries } from '@mobile/journey/services/conversations/conversation-transcript';
const now = '2026-09-21T10:00:00Z';
const until = '2026-09-21T11:00:00Z';
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data, requestId: 'request' });
const historyAnswer = (): AssistantResponse => ({
  schemaVersion: 'v1',
  threadId: 'thread-a',
  turnId: 'turn-a',
  responseId: 'response-a',
  revision: 2,
  kind: 'cards',
  presentation: 'replace',
  cardSetId: 'cards-a',
  message: [
    {
      text: '回答',
      retention: {
        retentionDecision: 'allow',
        retentionMode: 'session_only',
        sessionExpiresAt: until,
        freshUntil: until,
        displayUntil: until,
        retentionUntil: until,
        deletionScheduledAt: until,
        attribution: null,
        restoreMode: 'full',
        policyStatus: 'available',
        displayPolicyStatus: 'available',
      },
    },
  ],
  cards: {
    hero: {
      candidateId: 'shop',
      facts: { identity: { status: 'unknown', reason: '未確認' } },
      why: {
        text: '当時の理由',
        retention: {
          retentionDecision: 'allow',
          retentionMode: 'session_only',
          sessionExpiresAt: until,
          freshUntil: until,
          displayUntil: until,
          retentionUntil: until,
          deletionScheduledAt: until,
          attribution: null,
          restoreMode: 'full',
          policyStatus: 'available',
          displayPolicyStatus: 'available',
        },
      },
    },
    alts: [],
  },
});
const emptyClient = (): ConversationClient => ({
  get: (id) =>
    Promise.resolve(
      ok({
        schemaVersion: 'v1',
        requestId: 'request',
        conversation: {
          conversationId: id,
          title: id,
          createdAt: now,
          updatedAt: now,
          revision: 3,
          lastSequence: 2,
        },
        activeRun: null,
      }),
    ),
  list: vi.fn(),
  create: vi.fn(),
  messages: vi.fn(),
  send: vi.fn(),
  remove: vi.fn(),
  cancel: vi.fn(),
  watch: vi.fn(),
  run: vi.fn<() => Promise<ApiResult<ConversationRunResponse>>>(),
});
const make = (client: ConversationClient) =>
  new ConversationController({ client, id: () => 'id', now: () => now, onDisplay: () => {} });
describe('conversation restoration', () => {
  it('restores saved cards after A → B → A and after controller reconstruction without a completed run payload', async () => {
    const response = historyAnswer();
    if (response.kind !== 'cards') throw new Error('FIXTURE_MISSING');
    const cardPart = {
      kind: 'card_set' as const,
      threadId: response.threadId,
      cardSetId: response.cardSetId,
      revision: response.revision,
      photosExpireAt: null,
      cards: response.cards,
    };
    const api = emptyClient();
    const readRun = vi.fn<ConversationClient['run']>();
    api.run = readRun;
    api.messages = (id) =>
      Promise.resolve(
        ok({
          schemaVersion: 'v1',
          requestId: 'request',
          nextBeforeSequence: null,
          messages:
            id === 'a'
              ? [
                  {
                    conversationId: id,
                    sequence: 2,
                    createdAt: now,
                    message: {
                      messageId: 'answer',
                      role: 'assistant',
                      source: {
                        threadId: response.threadId,
                        turnId: response.turnId,
                        responseId: response.responseId,
                      },
                      parts: [cardPart],
                    },
                  },
                ]
              : [],
        }),
      );
    let controller = make(api);
    await controller.select('a');
    await controller.select('b');
    await controller.select('a');
    expect(
      conversationTranscriptEntries(controller.getSnapshot().messages, [], null)[0]?.parts,
    ).toContainEqual(cardPart);
    controller.dispose();
    controller = make(api);
    await controller.select('a');
    expect(controller.getSnapshot().messages[0]?.message.parts).toContainEqual(cardPart);
    expect(readRun).not.toHaveBeenCalled();
    controller.dispose();
  });
});
