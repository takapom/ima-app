import { describe, expect, it } from 'vitest';
import type { EvidenceRef, PublicCard } from '@ima/contracts';
import { candidateDetails } from '@mobile/journey/presentation/candidate-details';
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

describe('candidate details', () => {
  it('preserves full access and opening text hidden by the compact summary', () => {
    const details = candidateDetails({
      ...card,
      facts: {
        ...card.facts,
        opening_hours: known({
          timeZone: 'Asia/Tokyo',
          intervals: [],
          weeklyText: ['月〜金 12:00〜23:00', '定休日: 土日'],
          evaluatedAt: '2026-09-19T00:00:00Z',
          listedOpenAtEvaluation: null,
          nextBoundaryAt: null,
          lastOrderAt: null,
          lastOrderRaw: null,
        }),
      },
    });
    expect(details.rows.find((row) => row.label === 'アクセス')?.fact.label).toBe(
      '西口を出て直進、交差点の奥の建物2階',
    );
    const opening = details.rows.find((row) => row.label === '営業時間')?.fact.label;
    expect(opening).toContain('月〜金 12:00〜23:00 / 定休日: 土日');
    expect(opening).toContain('営業状況 未確認');
    expect(details.sourceUrl).toBe('https://example.com/shop/1');
  });

  it('never discloses expired identity, address or source links in the detail sheet', () => {
    const identity = card.facts.identity;
    if (identity?.status !== 'known') throw new Error('fixture identity must be known');
    const details = candidateDetails({
      ...card,
      facts: {
        identity: {
          ...identity,
          evidence: [
            {
              ...evidence,
              retention: { ...retention, displayPolicyStatus: 'expired' },
            },
          ],
        },
      },
    });
    expect(details.sourceUrl).toBeNull();
    expect(details.rows.map((row) => row.fact.status)).toEqual(['expired', 'expired']);
    expect(JSON.stringify(details)).not.toContain('東京都');
    expect(JSON.stringify(details)).not.toContain('example.com');
  });

  it('keeps failures and unsupported information distinct, without creating absent rows', () => {
    const details = candidateDetails({
      ...card,
      facts: {
        ...card.facts,
        price: { status: 'error', code: 'PROVIDER_UNAVAILABLE', reason: '取得に失敗しました' },
        last_train: { status: 'unsupported', reason: '終電の提供なし' },
      },
    });
    expect(details.rows.find((row) => row.label === '予算')?.fact.status).toBe('error');
    expect(details.rows.find((row) => row.label === '終電')?.fact.status).toBe('unsupported');
    expect(details.rows.some((row) => row.label === '営業時間')).toBe(false);
  });
});

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
