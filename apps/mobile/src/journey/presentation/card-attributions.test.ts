import { describe, expect, it } from 'vitest';
import type { EvidenceRef, PublicCard } from '@ima/contracts';
import {
  cardAttributions,
  footerAttributions,
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
  why: { text: '希望に合う候補', retention },
};

describe('result credits', () => {
  it('collects photo credits as well as the place source; explanations cite nothing', () => {
    const withCredits: PublicCard = {
      ...card,
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
      '店舗情報',
      '写真の撮影者',
    ]);
    expect(resultAttributions([withCredits, withCredits])).toHaveLength(2);
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

  it('keeps one linked Hot Pepper service credit in the result footer', () => {
    const identity = card.facts.identity;
    if (identity?.status !== 'known') throw new Error('fixture identity must be known');
    const hotPepperEvidence: EvidenceRef = {
      ...evidence,
      attributions: [
        { label: 'ホットペッパー グルメ', sourceLink: 'https://example.com/shop/1' },
        {
          label: 'Powered by ホットペッパーグルメ Webサービス',
          sourceLink: 'https://webservice.recruit.co.jp/',
        },
      ],
    };
    const hotPepperCard: PublicCard = {
      ...card,
      facts: {
        identity: {
          ...identity,
          evidence: [hotPepperEvidence],
        },
      },
    };

    expect(footerAttributions([hotPepperCard, hotPepperCard])).toEqual([
      {
        label: 'Powered by ホットペッパーグルメ Webサービス',
        sourceLink: 'https://webservice.recruit.co.jp/',
      },
    ]);
  });
});
