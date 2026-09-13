import { describe, expect, it } from 'vitest';
import type { EvidenceRef, PublicCard } from '@ima/contracts';
import {
  collectAttributions,
  collectPhotoAttributions,
  formatOpeningHours,
  presentCardFacts,
  presentEvidenceText,
  presentFact,
} from '../candidate-card-model';

const retention = {
  retentionDecision: 'deny' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: '2026-09-10T00:00:00Z',
  freshUntil: '2026-09-10T00:00:00Z',
  displayUntil: '2026-09-10T00:00:00Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only' as const,
  policyStatus: 'policy_withheld' as const,
  displayPolicyStatus: 'available' as const,
};

const evidence = (id: string, label: string): EvidenceRef => ({
  evidenceId: id,
  attribution: {
    label,
    sourceLink: `https://example.com/${id}`,
  },
  retention,
});

const card = (overrides: Partial<PublicCard['facts']> = {}): PublicCard => ({
  candidateId: 'candidate-1',
  facts: {
    identity: {
      status: 'known',
      value: {
        name: 'Melt',
        area: '恵比寿',
        address: null,
        category: 'cafe',
        businessStatus: 'operational',
        sourceUrl: null,
      },
      evidence: [evidence('identity-1', '店舗情報')],
    },
    ...overrides,
  },
  why: {
    text: '駅から近い',
    evidenceIds: [],
    evidence: [],
    basis: 'grounded',
    retention,
  },
  diff: {
    text: '静かな別案',
    evidenceIds: [],
    evidence: [],
    basis: 'inference',
    retention,
  },
});

describe('candidate card model', () => {
  it('keeps unknown, unsupported, error, and missing facts distinct', () => {
    expect(presentFact(undefined, String)).toMatchObject({ status: 'missing', label: '未提供' });
    expect(presentFact({ status: 'unknown', reason: '情報なし' }, String)).toMatchObject({
      status: 'unknown',
      label: '未確認: 情報なし',
    });
    expect(presentFact({ status: 'unsupported', reason: '対象外' }, String)).toMatchObject({
      status: 'unsupported',
      label: '未対応: 対象外',
    });
    expect(
      presentFact({ status: 'error', code: 'PROVIDER_UNAVAILABLE', reason: '停止中' }, String),
    ).toMatchObject({ status: 'error', label: '取得エラー: 停止中' });
  });

  it('formats opening hours using the contract timezone and preserves provider text', () => {
    expect(
      formatOpeningHours({
        timeZone: 'Asia/Tokyo',
        intervals: [],
        weeklyText: ['平日 10:00–20:00'],
        evaluatedAt: '2026-09-10T09:00:00Z',
        listedOpenAtEvaluation: true,
        nextBoundaryAt: '2026-09-10T11:00:00Z',
        lastOrderAt: null,
        lastOrderRaw: '19:30',
      }),
    ).toContain('確認時点では営業中 · 平日 10:00–20:00 · L.O. 19:30 · 営業時間の切替');
  });

  it('formats last train from its service date and source offset', () => {
    const facts = presentCardFacts(
      card({
        last_train: {
          status: 'known',
          value: {
            serviceDate: '2026-09-10',
            fromStationRef: 'station-from',
            homeStationRef: 'station-home',
            journeyRef: 'journey-1',
            lastDepartureAt: '2026-09-10T23:45:00+09:00',
            arrivesHomeAt: '2026-09-11T00:30:00+09:00',
            transfers: [],
            placeToStationSeconds: 600,
            arrivePlaceAt: '2026-09-10T20:00:00+09:00',
            leaveBy: '2026-09-10T23:30:00+09:00',
            availableStaySeconds: 3600,
            minimumStayMinutes: 30,
            usable: true,
          },
          evidence: [evidence('train-1', '終電情報')],
        },
      }),
    );

    expect(facts.lastTrain.label).toContain(
      '適用日 2026-09-10 · 店を出る時刻 2026-09-10 23:30 +09:00 · 終電発車 2026-09-10 23:45 +09:00 · 利用可能 · 滞在可能 60分',
    );
  });

  it('marks inference text and preserves the fact-specific source attribution', () => {
    const facts = presentCardFacts(
      card({
        price: {
          status: 'known',
          value: { level: 2, range: null, rawLabel: null },
          evidence: [evidence('price-1', '価格情報')],
        },
      }),
    );
    const cardData = card();
    if (cardData.diff === undefined) throw new Error('fixture diff is required');
    const text = presentEvidenceText(cardData.diff);

    expect(facts.price).toMatchObject({ status: 'known', label: '価格帯レベル 2' });
    expect(text.text).toBe('推定: 静かな別案');
    expect(collectAttributions([facts.price.evidence, text.evidence])).toEqual([
      { label: '価格情報', sourceLink: 'https://example.com/price-1' },
    ]);
  });

  it('prefers all public source credits when an evidence item has plural attributions', () => {
    const multiSourceEvidence: EvidenceRef = {
      ...evidence('multi-source-1', 'Hot Pepper'),
      attributions: [
        { label: 'Google Maps', sourceLink: 'https://maps.google.com' },
        { label: 'Hot Pepper', sourceLink: 'https://www.hotpepper.jp' },
      ],
    };

    expect(collectAttributions([[multiSourceEvidence]])).toEqual([
      { label: 'Google Maps', sourceLink: 'https://maps.google.com' },
      { label: 'Hot Pepper', sourceLink: 'https://www.hotpepper.jp' },
    ]);
  });

  it('falls back to the legacy attribution for an empty invalid plural field', () => {
    const legacyEvidence: EvidenceRef = {
      ...evidence('legacy-fallback-1', 'Legacy'),
      attributions: [],
    };

    expect(collectAttributions([[legacyEvidence]])).toEqual([
      { label: 'Legacy', sourceLink: 'https://example.com/legacy-fallback-1' },
    ]);
  });

  it('does not render known values when their public evidence is no longer available', () => {
    const expiredEvidence = {
      ...evidence('expired-1', '期限切れ情報'),
      retention: {
        ...retention,
        displayPolicyStatus: 'expired' as const,
        policyStatus: 'expired' as const,
      },
    };
    const result = presentFact(
      {
        status: 'known',
        value: '営業中',
        evidence: [expiredEvidence],
      },
      String,
    );
    const hiddenText = presentEvidenceText({
      ...card().why,
      retention: { ...retention, displayPolicyStatus: 'expired', policyStatus: 'expired' },
    });

    expect(result).toMatchObject({ status: 'expired', label: '表示期限切れ', evidence: [] });
    expect(hiddenText.status).toBe('expired');
  });

  it('keeps public photo author attribution beside the photo token', () => {
    const photoCard = card({
      photos: {
        status: 'known',
        value: {
          photos: [
            {
              photoToken: 'server-photo-token',
              attributions: [{ displayName: 'Photo author', uri: 'https://example.com/author' }],
              sourceUrl: 'https://example.com/place',
            },
          ],
        },
        evidence: [evidence('photo-1', '写真情報')],
      },
    });

    expect(collectPhotoAttributions(photoCard)).toEqual([
      { label: 'Photo author', sourceLink: 'https://example.com/author' },
    ]);
  });
});
