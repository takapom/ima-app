import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { AssistantResponseSchema } from '@contracts/response';
import { card, message } from '@contracts/tests/dto-fixtures';

const messageReply = {
  schemaVersion: 'v1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  responseId: 'response-1',
  revision: 1,
  kind: 'message',
  presentation: 'keep',
  cardSetId: null,
  message: [message],
};

const cardsReply = {
  ...messageReply,
  kind: 'cards',
  presentation: 'replace',
  cardSetId: 'cards-1',
  cards: { hero: card, alts: [] },
};

describe('search outcome on assistant replies', () => {
  it('lets a message reply say that the search in its turn found no candidates', () => {
    expect(
      v.safeParse(AssistantResponseSchema, { ...messageReply, searchOutcome: 'no_candidates' })
        .success,
    ).toBe(true);
  });

  it('keeps reading message replies from workers that do not send it', () => {
    expect(v.safeParse(AssistantResponseSchema, messageReply).success).toBe(true);
  });

  it('accepts no other outcome', () => {
    expect(
      v.safeParse(AssistantResponseSchema, { ...messageReply, searchOutcome: 'failed' }).success,
    ).toBe(false);
    expect(
      v.safeParse(AssistantResponseSchema, { ...messageReply, searchOutcome: null }).success,
    ).toBe(false);
  });

  it('is not part of card replies', () => {
    expect(v.safeParse(AssistantResponseSchema, cardsReply).success).toBe(true);
    expect(
      v.safeParse(AssistantResponseSchema, { ...cardsReply, searchOutcome: 'no_candidates' })
        .success,
    ).toBe(false);
  });
});
