import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  ConversationMessageInputSchema,
  retainConversationPart,
} from '@worker/domain/conversations/conversation-message';
import {
  ConversationSchema,
  conversationTitleFromUserText,
} from '@worker/domain/conversations/conversation';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';

const expiresAt = '2026-09-21T20:00:00.000Z';
const retention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: expiresAt,
  freshUntil: '2026-09-21T10:30:00.000Z',
  displayUntil: expiresAt,
  retentionUntil: expiresAt,
  deletionScheduledAt: expiresAt,
  attribution: { label: 'Provider', sourceLink: 'https://example.com/' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};
const source = { threadId: 'thread-1', turnId: 'turn-1', responseId: 'response-1' };

describe('conversation message retention', () => {
  it('keeps user-authored text across the exploration session boundary', () => {
    const part = { kind: 'user_text' as const, text: '静かなカフェを探したい' };
    expect(retainConversationPart(part, '2026-09-22T10:00:00.000Z')).toEqual(part);
  });

  it('quotes a past answer after fact freshness expires, but removes it at retention expiry', () => {
    const part = { kind: 'retained_text' as const, text: '以前の提案', retention };
    expect(retainConversationPart(part, '2026-09-21T11:00:00.000Z')).toEqual(part);
    expect(retainConversationPart(part, expiresAt)).toEqual({
      kind: 'unavailable',
      reason: 'expired',
    });
  });

  it('honours the shortest display/deletion deadline and never restores scrubbed text', () => {
    const part = {
      kind: 'retained_text' as const,
      text: '表示期限付きの説明',
      retention: { ...retention, displayUntil: '2026-09-21T12:00:00.000Z' },
    };
    const scrubbed = retainConversationPart(part, '2026-09-21T12:00:00.000Z');
    expect(scrubbed).toEqual({ kind: 'unavailable', reason: 'expired' });
    expect(retainConversationPart(scrubbed, '2026-09-21T11:00:00.000Z')).toEqual(scrubbed);
    expect(
      retainConversationPart(
        {
          ...part,
          retention: { ...retention, deletionScheduledAt: '2026-09-21T11:00:00.000Z' },
        },
        '2026-09-21T11:00:00.000Z',
      ),
    ).toEqual({ kind: 'unavailable', reason: 'expired' });
  });

  it.each(['deny', 'unknown'] as const)(
    'withholds %s content before it reaches storage',
    (decision) => {
      const part = {
        kind: 'retained_text' as const,
        text: '保存しない本文',
        retention: {
          ...retention,
          retentionDecision: decision,
          retentionMode: 'none' as const,
          retentionUntil: null,
          deletionScheduledAt: null,
          restoreMode: 'unavailable' as const,
          policyStatus: 'policy_withheld' as const,
          displayPolicyStatus: 'policy_withheld' as const,
        },
      };
      expect(retainConversationPart(part, '2026-09-21T10:00:00.000Z')).toEqual({
        kind: 'unavailable',
        reason: 'policy_withheld',
      });
    },
  );

  it('does not accept assistant text under the indefinite user-text policy', () => {
    expect(
      v.safeParse(ConversationMessageInputSchema, {
        messageId: 'message-1',
        role: 'assistant',
        source,
        parts: [{ kind: 'user_text', text: '店舗の説明' }],
      }).success,
    ).toBe(false);
  });

  it('rejects cross-thread card references and assistant responses without provenance', () => {
    const message = {
      messageId: 'message-1',
      role: 'assistant',
      source,
      parts: [{ kind: 'card_set_reference', threadId: 'thread-foreign', cardSetId: 'cards-1' }],
    };
    expect(v.safeParse(ConversationMessageInputSchema, message).success).toBe(false);
    expect(
      v.safeParse(ConversationMessageInputSchema, {
        ...message,
        source: null,
        parts: [{ kind: 'retained_text', text: '回答', retention }],
      }).success,
    ).toBe(false);
  });

  it('rejects invalid clocks and an inconsistent retention window', () => {
    expect(() => retainConversationPart({ kind: 'user_text', text: '入力' }, 'invalid')).toThrow();
    expect(() =>
      retainConversationPart(
        {
          kind: 'retained_text',
          text: '回答',
          retention: { ...retention, retentionUntil: '2026-09-22T20:00:00.000Z' },
        },
        '2026-09-21T10:00:00.000Z',
      ),
    ).toThrow();
  });

  it('preserves an explicit expired status and rejects blank user messages', () => {
    expect(
      retainConversationPart(
        {
          kind: 'retained_text',
          text: '回答',
          retention: { ...retention, displayPolicyStatus: 'expired' },
        },
        '2026-09-21T10:00:00.000Z',
      ),
    ).toEqual({ kind: 'unavailable', reason: 'expired' });
    expect(
      v.safeParse(ConversationMessageInputSchema, {
        messageId: 'blank',
        role: 'user',
        source: null,
        parts: [{ kind: 'user_text', text: '  \n ' }],
      }).success,
    ).toBe(false);
  });
});

describe('conversation metadata', () => {
  it('rejects an update timestamp preceding creation', () => {
    expect(
      v.safeParse(ConversationSchema, {
        conversationId: 'conversation-1',
        ownerScopeRef: 'owner-1',
        title: '会話',
        createdAt: expiresAt,
        updatedAt: '2026-09-21T10:00:00.000Z',
        revision: 1,
        lastSequence: 0,
      }).success,
    ).toBe(false);
  });

  it('uses a short user title without splitting surrogate pairs', () => {
    expect(conversationTitleFromUserText('  恵比寿\nで  カフェ ')).toBe('恵比寿 で カフェ');
    expect(conversationTitleFromUserText('🍰'.repeat(41))).toBe('🍰'.repeat(40));
    expect(conversationTitleFromUserText('   ')).toBe('新しい会話');
  });
});
