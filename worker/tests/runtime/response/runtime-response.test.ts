import * as v from 'valibot';
import { expect, describe, it } from 'vitest';
import { AssistantResponseSchema } from '@ima/contracts';
import {
  type ValidatedCard,
  type ValidatedMessageResponse,
} from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';
import {
  mapCommittedResponseToPublic,
  RuntimePublicResponseError,
} from '@worker/runtime/response/runtime-response';
import {
  card,
  cardEvidenceLinks,
  responseMetadata,
  retention,
} from './runtime-response-card-fixture';

describe('Core committed response to public DTO mapping', () => {
  it('maps a message response to plain text with retention and no citations', () => {
    const response: ValidatedMessageResponse = {
      presentation: 'keep',
      message: '条件を確認しました',
    };
    const publicResponse = mapCommittedResponseToPublic(response, responseMetadata);
    expect(v.safeParse(AssistantResponseSchema, publicResponse).success).toBe(true);
    expect(publicResponse).toMatchObject({
      kind: 'message',
      presentation: 'keep',
      cardSetId: null,
      message: [{ text: '条件を確認しました', retention }],
    });
    expect(publicResponse.message[0]).not.toHaveProperty('evidenceIds');
    expect(publicResponse.message[0]).not.toHaveProperty('basis');
    expect(JSON.stringify(publicResponse)).not.toContain('recordRef');
  });

  it('carries facilities onto the public card so amenity display has data to render', () => {
    const withFacilities: ValidatedCard = {
      ...card,
      evidenceIds: [...card.evidenceIds, 'obs-facilities'],
      facilities: {
        wifi: 'yes',
        nonSmoking: 'partial',
        privateRoom: 'unknown',
        parking: 'no',
        sourceText: [],
      },
    };
    const publicResponse = mapCommittedResponseToPublic(
      { presentation: 'replace' as const, message: [card.why], hero: withFacilities, alts: [] },
      {
        ...responseMetadata,
        cardSetId: 'card-set-facilities',
        resolveCardEvidence: (_candidateId, evidenceId) => cardEvidenceLinks.get(evidenceId),
        resolvePhotoToken: () => 'photo-token-public',
      },
    );

    expect(v.safeParse(AssistantResponseSchema, publicResponse).success).toBe(true);
    if (publicResponse.kind !== 'cards') throw new Error('expected cards response');
    expect(publicResponse.cards.hero.facts.facilities).toMatchObject({
      status: 'known',
      value: { wifi: 'yes', nonSmoking: 'partial' },
    });
  });

  it('omits the facilities fact entirely when the provider supplied none', () => {
    const publicResponse = mapCommittedResponseToPublic(
      { presentation: 'replace' as const, message: [card.why], hero: card, alts: [] },
      {
        ...responseMetadata,
        cardSetId: 'card-set-no-facilities',
        resolveCardEvidence: (_candidateId, evidenceId) => cardEvidenceLinks.get(evidenceId),
        resolvePhotoToken: () => 'photo-token-public',
      },
    );

    expect(v.safeParse(AssistantResponseSchema, publicResponse).success).toBe(true);
    if (publicResponse.kind !== 'cards') throw new Error('expected cards response');
    expect(publicResponse.cards.hero.facts.facilities).toBeUndefined();
  });

  it('maps cards with field evidence, photo token translation, and no internal source objects', () => {
    const response = {
      presentation: 'replace' as const,
      message: [card.why],
      hero: card,
      alts: [],
    };
    const publicResponse = mapCommittedResponseToPublic(response, {
      ...responseMetadata,
      cardSetId: 'card-set-final',
      resolveCardEvidence: (_candidateId, evidenceId) => cardEvidenceLinks.get(evidenceId),
      resolvePhotoToken: (_candidateId, photoRef) =>
        photoRef === 'photo-internal-token' ? 'photo-token-public' : undefined,
    });
    expect(v.safeParse(AssistantResponseSchema, publicResponse).success).toBe(true);
    expect(publicResponse.kind).toBe('cards');
    if (publicResponse.kind !== 'cards') throw new Error('expected cards response');
    expect(publicResponse.cards.hero.facts.photos).toMatchObject({
      status: 'known',
      value: { photos: [{ photoToken: 'photo-token-public' }] },
    });
    const identityFact = publicResponse.cards.hero.facts.identity;
    if (identityFact.status !== 'known') throw new Error('expected known identity fact');
    expect(identityFact.evidence).toEqual([
      { evidenceId: 'obs-identity', attribution: retention.attribution, retention },
    ]);
    expect(JSON.stringify(publicResponse)).not.toContain('recordRef');
    expect(JSON.stringify(publicResponse)).not.toContain('photo-internal-token');
  });

  it('requires an explicit card-set ID and card evidence resolver for card responses', () => {
    const response = {
      presentation: 'replace' as const,
      message: [card.why],
      hero: card,
      alts: [],
    };
    expect(() => mapCommittedResponseToPublic(response, responseMetadata)).toThrowError(
      new RuntimePublicResponseError('CARD_SET_ID_REQUIRED'),
    );
    expect(() =>
      mapCommittedResponseToPublic(response, {
        ...responseMetadata,
        cardSetId: 'card-set-final',
      }),
    ).toThrowError(new RuntimePublicResponseError('CARD_EVIDENCE_RESOLVER_REQUIRED'));
    const publicResponse = mapCommittedResponseToPublic(response, {
      ...responseMetadata,
      cardSetId: 'card-set-final',
      resolveCardEvidence: (_candidateId, evidenceId) => cardEvidenceLinks.get(evidenceId),
    });
    if (publicResponse.kind !== 'cards') throw new Error('expected cards response');
    expect(publicResponse.cards.hero.facts.photos).toMatchObject({
      status: 'unknown',
      reason: '写真を表示できません',
    });
  });

  it('withholds missing photo evidence while keeping the card usable', () => {
    const response = {
      presentation: 'replace' as const,
      message: [card.why],
      hero: { ...card, evidenceIds: ['obs-identity', 'obs-opening'] },
      alts: [],
    };
    const publicResponse = mapCommittedResponseToPublic(response, {
      ...responseMetadata,
      cardSetId: 'card-set-photo-withheld',
      resolveCardEvidence: (_candidateId, evidenceId) => cardEvidenceLinks.get(evidenceId),
      resolvePhotoToken: () => undefined,
    });
    expect(v.safeParse(AssistantResponseSchema, publicResponse).success).toBe(true);
    if (publicResponse.kind !== 'cards') throw new Error('expected cards response');
    expect(publicResponse.cards.hero.facts.photos).toMatchObject({
      status: 'unknown',
      reason: '写真を表示できません',
    });
    expect(JSON.stringify(publicResponse)).not.toContain('photo-internal-token');
  });

  it('distinguishes an actual empty photo set from a partially withheld set', () => {
    if (card.photos === null) throw new Error('photo fixture is incomplete');
    const originalPhotos = card.photos;
    const response = {
      presentation: 'replace' as const,
      message: [card.why],
      hero: { ...card, photos: { photos: [] } },
      alts: [],
    };
    const emptyResponse = mapCommittedResponseToPublic(response, {
      ...responseMetadata,
      cardSetId: 'card-set-photo-empty',
      resolveCardEvidence: (_candidateId, evidenceId) => cardEvidenceLinks.get(evidenceId),
      resolvePhotoToken: () => undefined,
    });
    if (emptyResponse.kind !== 'cards') throw new Error('expected cards response');
    expect(emptyResponse.cards.hero.facts.photos).toMatchObject({
      status: 'known',
      value: { photos: [] },
    });

    const partialResponse = mapCommittedResponseToPublic(
      {
        ...response,
        hero: {
          ...card,
          photos: {
            photos: [
              ...originalPhotos.photos,
              {
                photoRef: 'photo-internal-token-2',
                attributions: [],
                sourceUrl: null,
              },
            ],
          },
        },
      },
      {
        ...responseMetadata,
        cardSetId: 'card-set-photo-partial',
        resolveCardEvidence: (_candidateId, evidenceId) => cardEvidenceLinks.get(evidenceId),
        resolvePhotoToken: (_candidateId, photoRef) =>
          photoRef === 'photo-internal-token' ? 'photo-token-public' : undefined,
      },
    );
    if (partialResponse.kind !== 'cards') throw new Error('expected cards response');
    expect(partialResponse.cards.hero.facts.photos).toMatchObject({
      status: 'known',
      value: {
        photos: [{ photoToken: 'photo-token-public' }],
        partialReason: '一部の写真は表示できません',
      },
    });
  });
});
