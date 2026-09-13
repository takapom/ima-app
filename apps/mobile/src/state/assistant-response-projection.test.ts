import { describe, expect, it } from 'vitest';
import type { EvidenceRef, PublicCard, PublicMessage, RetentionMetadata } from '@ima/contracts';
import { presentFact } from '../components/candidates/candidate-card-model';
import { presentDecidedIdentity } from '../components/decided-state-model';
import { createAssistantResponseState } from './assistant-response';
import {
  nextAssistantResponseExpiryAt,
  projectAssistantResponseState,
} from './assistant-response-projection';

const availableRetention = (displayUntil: string | null): RetentionMetadata => ({
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-12T00:00:00Z',
  freshUntil: '2026-09-10T12:00:00Z',
  displayUntil,
  retentionUntil: '2026-09-12T00:00:00Z',
  deletionScheduledAt: '2026-09-12T00:00:00Z',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
});

const evidence = (id: string, displayUntil: string | null): EvidenceRef => ({
  evidenceId: id,
  attribution: null,
  retention: availableRetention(displayUntil),
});

const text = (
  value: string,
  displayUntil: string | null,
  sourceEvidence: readonly EvidenceRef[] = [],
): PublicMessage => ({
  text: value,
  evidenceIds: sourceEvidence.map((item) => item.evidenceId),
  evidence: [...sourceEvidence],
  basis: 'grounded',
  retention: availableRetention(displayUntil),
});

const card = (): PublicCard => {
  const identityEvidence = evidence('identity', '2026-09-10T00:00:00Z');
  const walkingEvidence = evidence('walking', '2026-09-10T00:00:00Z');
  const photoEvidence = evidence('photo', '2026-09-10T00:00:00Z');
  const explanationEvidence = evidence('why', '2026-09-10T00:00:00Z');
  return {
    candidateId: 'candidate-1',
    facts: {
      identity: {
        status: 'known',
        value: {
          name: '夜カフェ',
          area: '渋谷',
          address: null,
          category: 'カフェ',
          businessStatus: 'operational',
          sourceUrl: null,
        },
        evidence: [identityEvidence],
      },
      walking_route: {
        status: 'known',
        value: {
          originRef: 'origin-1',
          destinationCandidateId: 'candidate-1',
          originRevision: 1,
          evaluatedAt: '2026-09-09T12:00:00Z',
          durationSeconds: 600,
          distanceMeters: 700,
          warnings: [],
        },
        evidence: [walkingEvidence],
      },
      photos: {
        status: 'known',
        value: {
          photos: [
            {
              photoToken: 'photo-1',
              attributions: [],
              sourceUrl: null,
            },
          ],
        },
        evidence: [photoEvidence],
      },
    },
    why: text('静かに話せます', '2026-09-10T00:00:00Z', [explanationEvidence]),
    diff: text('駅から近い', '2026-09-10T00:00:00Z', [explanationEvidence]),
  };
};

const stateWithContent = () => {
  const state = createAssistantResponseState('thread-1');
  const message = text('候補を確認しました', '2026-09-10T00:00:00Z');
  return {
    ...state,
    revision: 1,
    responseRecords: [
      {
        responseId: 'response-1',
        turnId: 'turn-1',
        revision: 1,
        kind: 'cards' as const,
        presentation: 'replace' as const,
        declaredCardSetId: 'cards-1',
        effectiveCardSetId: 'cards-1',
        messages: [message],
      },
    ],
    cardSetId: 'cards-1',
    cards: { hero: card(), alts: [] },
    cardSetDisplay: {
      kind: 'available' as const,
      responseId: 'response-1',
      sourceRevision: 1,
    },
  };
};

describe('assistant response expiry projection', () => {
  it('finds the next boundary and does not schedule already-expired deadlines', () => {
    const raw = stateWithContent();

    expect(nextAssistantResponseExpiryAt(raw, '2026-09-09T23:59:59Z')).toBe('2026-09-10T00:00:00Z');
    expect(nextAssistantResponseExpiryAt(raw, '2026-09-10T00:00:00Z')).toBe('2026-09-12T00:00:00Z');
    expect(nextAssistantResponseExpiryAt(raw, '2026-09-12T00:00:00Z')).toBeNull();
  });

  it('keeps all TTL-bound values available before displayUntil', () => {
    const raw = stateWithContent();
    const projected = projectAssistantResponseState(raw, '2026-09-09T23:59:59Z');
    const projectedCard = projected.cards?.hero;

    expect(projectedCard?.facts.identity.status).toBe('known');
    expect(projectedCard?.facts.walking_route?.status).toBe('known');
    expect(projectedCard?.facts.photos?.status).toBe('known');
    expect(projectedCard?.why.retention.displayPolicyStatus).toBe('available');
    expect(projected.responseRecords[0]?.messages[0]?.retention.displayPolicyStatus).toBe(
      'available',
    );
    expect(presentDecidedIdentity(projectedCard ?? null)?.name).toBe('夜カフェ');
  });

  it.each(['2026-09-10T00:00:00Z', '2026-09-10T00:00:01Z'])(
    'expires fields, evidence text, and messages at or after the boundary (%s)',
    (now) => {
      const raw = stateWithContent();
      const projected = projectAssistantResponseState(raw, now);
      const projectedCard = projected.cards?.hero;
      const identity = projectedCard?.facts.identity;
      const walking = projectedCard?.facts.walking_route;
      const photos = projectedCard?.facts.photos;

      if (identity?.status !== 'known') throw new Error('identity fixture should remain known');
      if (walking?.status !== 'known') throw new Error('walking fixture should remain known');
      if (photos?.status !== 'known') throw new Error('photo fixture should remain known');
      expect(identity.evidence[0]?.retention.displayPolicyStatus).toBe('expired');
      expect(walking.evidence[0]?.retention.displayPolicyStatus).toBe('expired');
      expect(photos.evidence[0]?.retention.displayPolicyStatus).toBe('expired');
      expect(presentFact(identity, String).status).toBe('expired');
      expect(presentDecidedIdentity(projectedCard ?? null)).toBeNull();
      expect(projectedCard?.why.retention.displayPolicyStatus).toBe('expired');
      expect(projectedCard?.diff?.retention.displayPolicyStatus).toBe('expired');
      expect(projected.responseRecords[0]?.messages[0]?.retention.displayPolicyStatus).toBe(
        'expired',
      );
    },
  );

  it('expires a text when its evidence expires even if its own TTL is later', () => {
    const raw = stateWithContent();
    const rawCards = raw.cards;
    if (rawCards === null) throw new Error('card fixture is required');
    const cardWithLaterText = {
      ...rawCards.hero,
      why: text('根拠あり', '2026-09-11T00:00:00Z', [
        evidence('why-early', '2026-09-10T00:00:00Z'),
      ]),
    };
    const state = { ...raw, cards: { hero: cardWithLaterText, alts: [] } };
    const projected = projectAssistantResponseState(state, '2026-09-10T00:00:00Z');

    expect(projected.cards?.hero.why.retention.displayPolicyStatus).toBe('expired');
  });

  it('derives each view from raw state without mutating the retained payload', () => {
    const raw = stateWithContent();
    const beforeExpiry = projectAssistantResponseState(raw, '2026-09-09T23:59:59Z');
    const expired = projectAssistantResponseState(raw, '2026-09-10T00:00:00Z');
    const beforeIdentity = beforeExpiry.cards?.hero.facts.identity;
    const expiredIdentity = expired.cards?.hero.facts.identity;

    if (beforeIdentity?.status !== 'known') throw new Error('before identity should be known');
    if (expiredIdentity?.status !== 'known') throw new Error('expired identity should be known');
    const rawCards = raw.cards;
    if (rawCards === null || rawCards.hero.facts.identity.status !== 'known') {
      throw new Error('raw identity should be known');
    }
    expect(beforeIdentity.evidence[0]?.retention.displayPolicyStatus).toBe('available');
    expect(expiredIdentity.evidence[0]?.retention.displayPolicyStatus).toBe('expired');
    expect(rawCards.hero.facts.identity.status).toBe('known');
    expect(rawCards.hero.facts.identity.evidence[0]?.retention.displayPolicyStatus).toBe(
      'available',
    );
    expect(raw.responseRecords[0]?.messages[0]?.retention.displayPolicyStatus).toBe('available');
  });

  it.each(['sessionExpiresAt', 'deletionScheduledAt'] as const)(
    'expires a payload when %s reaches its boundary even without displayUntil',
    (deadline) => {
      const raw = stateWithContent();
      const rawCards = raw.cards;
      if (rawCards === null) throw new Error('card fixture is required');
      const deadlineRetention: RetentionMetadata =
        deadline === 'sessionExpiresAt'
          ? {
              retentionDecision: 'deny',
              retentionMode: 'session_only',
              sessionExpiresAt: '2026-09-10T00:00:00Z',
              freshUntil: null,
              displayUntil: null,
              retentionUntil: null,
              deletionScheduledAt: null,
              attribution: null,
              restoreMode: 'reference_only',
              policyStatus: 'policy_withheld',
              displayPolicyStatus: 'available',
            }
          : {
              ...availableRetention('2026-09-11T00:00:00Z'),
              deletionScheduledAt: '2026-09-10T00:00:00Z',
            };
      const identity = rawCards.hero.facts.identity;
      const record = raw.responseRecords[0];
      const message = record?.messages[0];
      const identityEvidence = identity.status === 'known' ? identity.evidence[0] : undefined;
      if (
        identity.status !== 'known' ||
        identityEvidence === undefined ||
        record === undefined ||
        message === undefined
      ) {
        throw new Error('deadline fixtures are required');
      }
      const state = {
        ...raw,
        cards: {
          hero: {
            ...rawCards.hero,
            facts: {
              ...rawCards.hero.facts,
              identity: {
                ...identity,
                evidence: [{ ...identityEvidence, retention: deadlineRetention }],
              },
            },
          },
          alts: [],
        },
        responseRecords: [
          {
            ...record,
            messages: [{ ...message, retention: deadlineRetention }],
          },
        ],
      };
      const projected = projectAssistantResponseState(state, '2026-09-10T00:00:00Z');
      if (projected.cards === null) throw new Error('projected card fixture is required');

      expect(presentFact(projected.cards.hero.facts.identity, String).status).toBe('expired');
      expect(projected.responseRecords[0]?.messages[0]?.retention.displayPolicyStatus).toBe(
        'expired',
      );
    },
  );

  it('preserves an existing non-available policy status', () => {
    const raw = stateWithContent();
    const rawCards = raw.cards;
    if (rawCards === null) throw new Error('card fixture is required');
    const existingStatus = {
      ...rawCards.hero,
      facts: {
        ...rawCards.hero.facts,
        photos: { status: 'unsupported' as const, reason: '写真API未対応' },
      },
    };
    const state = { ...raw, cards: { hero: existingStatus, alts: [] } };
    const projected = projectAssistantResponseState(state, '2026-09-10T00:00:00Z');

    expect(projected.cards?.hero.facts.photos).toEqual({
      status: 'unsupported',
      reason: '写真API未対応',
    });
  });
});
