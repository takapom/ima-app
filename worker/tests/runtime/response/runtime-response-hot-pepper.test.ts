import { describe, expect, it } from 'vitest';
import type {
  EvidenceLink,
  ValidatedCardsResponse,
} from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import {
  mapCommittedResponseToPublic,
  RuntimePublicResponseError,
} from '@worker/runtime/response/runtime-response';
import { card, requireCardEvidenceLink } from './runtime-response-card-fixture';

const availableRetention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-11T00:00:00.000Z',
  freshUntil: '2026-09-10T13:00:00.000Z',
  displayUntil: '2026-09-10T18:00:00.000Z',
  retentionUntil: '2026-09-10T23:00:00.000Z',
  deletionScheduledAt: '2026-09-10T23:00:00.000Z',
  attribution: { label: 'ホットペッパー', sourceLink: 'https://www.hotpepper.jp' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const hpIdentity: EvidenceLink = {
  observationId: 'hp-observation',
  candidateId: card.candidateId,
  field: 'identity',
  sources: [
    {
      provider: 'hotpepper',
      recordRef: 'hp-record',
      attribution: 'ホットペッパー',
      publicUrl: 'https://www.hotpepper.jp',
    },
  ],
  retention: availableRetention,
};

const hpSource = hpIdentity.sources[0];
if (hpSource === undefined) throw new Error('HP source fixture is missing');

const policyRetention: RetentionMetadata = {
  ...availableRetention,
  attribution: { label: 'Policy credit', sourceLink: 'https://example.com/policy-credit' },
};

const opening = requireCardEvidenceLink('obs-opening');

/** A card whose identity is backed by `identity`; generated text never carries citations. */
const cardsWith = (identity: EvidenceLink): ValidatedCardsResponse => ({
  presentation: 'replace',
  message: ['候補です'],
  hero: {
    ...card,
    photos: null,
    evidenceIds: [identity.observationId, opening.observationId],
  },
  alts: [],
});

const options = (identity: EvidenceLink | undefined) => ({
  threadId: 'thread-hp',
  turnId: 'turn-hp',
  responseId: 'response-hp',
  revision: 1,
  cardSetId: 'card-set-hp',
  textRetention: availableRetention,
  resolveCardEvidence: (candidateId: string, evidenceId: string) =>
    candidateId !== card.candidateId
      ? undefined
      : evidenceId === opening.observationId
        ? opening
        : evidenceId === identity?.observationId
          ? identity
          : undefined,
});

const identityEvidence = (identity: EvidenceLink) => {
  const response = mapCommittedResponseToPublic(cardsWith(identity), options(identity));
  if (response.kind !== 'cards') throw new Error('cards response expected');
  const fact = response.cards.hero.facts.identity;
  if (fact.status !== 'known') throw new Error('identity fact expected');
  return { response, evidence: fact.evidence };
};

describe('runtime public Hot Pepper evidence', () => {
  it('fails closed when card evidence cannot be re-resolved', () => {
    expect(() => mapCommittedResponseToPublic(cardsWith(hpIdentity), options(undefined))).toThrow(
      new RuntimePublicResponseError('CARD_EVIDENCE_MISSING'),
    );
  });

  it('publishes every source credit without exposing provider records', () => {
    const mixed: EvidenceLink = {
      ...hpIdentity,
      observationId: 'google-hp-observation',
      retention: policyRetention,
      sources: [
        {
          provider: 'google_places',
          recordRef: 'google-record',
          attribution: 'Google Maps',
          publicUrl: 'https://maps.google.com',
        },
        hpSource,
      ],
    };
    const { response, evidence } = identityEvidence(mixed);
    expect(evidence).toEqual([
      {
        evidenceId: mixed.observationId,
        attribution: policyRetention.attribution,
        attributions: [
          { label: 'Google Maps', sourceLink: 'https://maps.google.com' },
          { label: 'ホットペッパー', sourceLink: 'https://www.hotpepper.jp' },
          { label: 'Policy credit', sourceLink: 'https://example.com/policy-credit' },
        ],
        retention: policyRetention,
      },
    ]);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('google_places');
    expect(serialized).not.toContain('google-record');
    expect(serialized).not.toContain('hp-record');
  });

  it('keeps a policy-owned singular credit unchanged for one source', () => {
    const { evidence } = identityEvidence({ ...hpIdentity, retention: policyRetention });
    expect(evidence).toEqual([
      {
        evidenceId: hpIdentity.observationId,
        attribution: policyRetention.attribution,
        retention: policyRetention,
      },
    ]);
    expect(evidence[0]).not.toHaveProperty('attributions');
  });
});
