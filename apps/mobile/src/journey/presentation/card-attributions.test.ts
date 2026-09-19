import { describe, expect, it } from 'vitest';
import type { EvidenceRef, PublicCard } from '@ima/contracts';
import {
  cardAttributions,
  resultAttributions,
} from '@mobile/journey/presentation/card-attributions';

const retention = {
  retentionDecision: 'deny' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: '2026-09-20T00:00:00Z',
  freshUntil: '2026-09-20T00:00:00Z',
  displayUntil: '2026-09-20T00:00:00Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only' as const,
  policyStatus: 'available' as const,
  displayPolicyStatus: 'available' as const,
};
const evidence: EvidenceRef = {
  evidenceId: 'shop',
  retention,
  attribution: { label: '店舗情報', sourceLink: 'https://example.com/shop/1' },
};
const known = <T>(value: T) => ({ status: 'known' as const, value, evidence: [evidence] });
const card: PublicCard = {
  candidateId: 'candidate-1',
  facts: {
    identity: known({
      name: '恵比寿の店',
      area: '恵比寿',
      category: 'カフェ',
      address: '東京都渋谷区の長い住所',
      stationName: '恵比寿',
      accessText: '西口を出て直進、交差点の奥の建物2階',
      sourceUrl: 'https://example.com/shop/1',
      businessStatus: 'unknown',
    }),
  },
  why: { text: '希望に合う候補', evidenceIds: [], evidence: [], basis: 'grounded', retention },
};

describe('result credits', () => {
  it('collects photo and explanation credits as well as the place source', () => {
    const withCredits: PublicCard = {
      ...card,
      why: {
        ...card.why,
        evidence: [
          {
            ...evidence,
            evidenceId: 'reason',
            attribution: { label: '提案の出典', sourceLink: 'https://example.com/reason' },
          },
        ],
      },
      facts: {
        ...card.facts,
        photos: known({
          photos: [
            {
              photoToken: 'photo',
              sourceUrl: null,
              attributions: [{ displayName: '写真の撮影者', uri: 'https://example.com/photo' }],
            },
          ],
        }),
      },
    };
    expect(cardAttributions(withCredits).map((credit) => credit.label)).toEqual([
      '提案の出典',
      '店舗情報',
      '写真の撮影者',
    ]);
    expect(resultAttributions([withCredits, withCredits])).toHaveLength(3);
  });

  it('does not make one shared footer label link to the wrong shop', () => {
    const identity = card.facts.identity;
    if (identity?.status !== 'known') throw new Error('fixture identity must be known');
    const other: PublicCard = {
      ...card,
      candidateId: 'candidate-2',
      facts: {
        identity: {
          ...identity,
          evidence: [
            {
              ...evidence,
              attribution: { label: '店舗情報', sourceLink: 'https://example.com/shop/2' },
            },
          ],
        },
      },
    };
    expect(resultAttributions([card, other])).toEqual([{ label: '店舗情報', sourceLink: null }]);
    expect(cardAttributions(other)[0]?.sourceLink).toBe('https://example.com/shop/2');
  });
});
