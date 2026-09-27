import type { ConversationMessage } from '@ima/contracts';

import {
  retainConversationCards,
  conversationCardsDeadlines,
} from '@mobile/journey/services/conversations/conversation-card-retention';

export const conversationMessageDeadline = (message: ConversationMessage): number | null => {
  const values = message.message.parts.flatMap((part) =>
    part.kind === 'retained_text'
      ? [
          part.retention.sessionExpiresAt,
          part.retention.displayUntil,
          part.retention.retentionUntil,
          part.retention.deletionScheduledAt,
        ]
          .filter((value) => value !== null)
          .map(Date.parse)
      : part.kind === 'card_set'
        ? conversationCardsDeadlines(part)
        : [],
  );
  return values.length === 0 ? null : Math.min(...values);
};
export const retainConversationMessage = (
  message: ConversationMessage,
  now: string,
): ConversationMessage => ({
  ...message,
  message: {
    ...message.message,
    parts: message.message.parts.map((part) => {
      if (part.kind === 'card_set') return retainConversationCards(part, now);
      if (part.kind !== 'retained_text') return part;
      const policy = part.retention;
      if (policy.policyStatus === 'expired' || policy.displayPolicyStatus === 'expired')
        return { kind: 'unavailable', reason: 'expired' };
      if (
        policy.retentionDecision !== 'allow' ||
        policy.restoreMode !== 'full' ||
        policy.policyStatus !== 'available' ||
        policy.displayPolicyStatus !== 'available' ||
        policy.retentionUntil === null ||
        policy.deletionScheduledAt === null
      )
        return { kind: 'unavailable', reason: 'policy_withheld' };
      const deadline = Math.min(
        ...[
          policy.sessionExpiresAt,
          policy.displayUntil,
          policy.retentionUntil,
          policy.deletionScheduledAt,
        ]
          .filter((value) => value !== null)
          .map(Date.parse),
      );
      return Date.parse(now) >= deadline ? { kind: 'unavailable', reason: 'expired' } : part;
    }),
  },
});
