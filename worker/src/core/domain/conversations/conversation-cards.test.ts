import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  ConversationCardsSchema,
  ConversationPhotoSourceSchema,
} from '@worker/core/domain/conversations/conversation-cards';

const source = { candidateId: 'shop', provider: 'example', recordRef: 'shop-1' };

describe('conversation photo source identity', () => {
  it('stores a provider shop identity without requiring a hot pepper shop id', () => {
    expect(v.parse(ConversationPhotoSourceSchema, source)).toEqual(source);
    expect(
      v.parse(ConversationPhotoSourceSchema, {
        candidateId: 'shop',
        provider: 'hotpepper',
        recordRef: 'not-a-shop-page-id',
      }).provider,
    ).toBe('hotpepper');
  });

  it.each([
    { ...source, candidateId: '' },
    { ...source, candidateId: 'has space' },
    { ...source, provider: '' },
    { ...source, provider: 'p'.repeat(81) },
    { ...source, recordRef: '' },
    { ...source, recordRef: 'r'.repeat(513) },
  ])('rejects a photo source that breaks the structural limits', (value) => {
    expect(v.safeParse(ConversationPhotoSourceSchema, value).success).toBe(false);
  });

  it('keeps at most three photo sources on one card set', () => {
    const photoSources = ConversationCardsSchema.entries.photoSources;
    expect(v.safeParse(photoSources, [source, source, source]).success).toBe(true);
    expect(v.safeParse(photoSources, [source, source, source, source]).success).toBe(false);
  });
});
