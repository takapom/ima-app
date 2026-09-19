import { describe, expect, it } from 'vitest';
import type { EvidenceRef, OpeningHours, PublicCard } from '@ima/contracts';
import {
  toCardViewModel,
  CLOSING_SOON_MINUTES,
} from '@mobile/journey/presentation/candidate-card-view';
import {
  toCandidateDetailViewModel,
  detailSections,
  detailActions,
  candidateDetailPhotos,
} from '@mobile/journey/presentation/candidate-detail-view';
import type { ReadyPhotoImage } from '@mobile/journey/state/photo-image-state';

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

const evidence = (id: string): EvidenceRef => ({
  evidenceId: id,
  attribution: { label: 'ホットペッパー グルメ', sourceLink: 'https://example.com/shop' },
  retention,
});

const known = <T>(value: T, evidenceId = 'evidence-1') => ({
  status: 'known' as const,
  value,
  evidence: [evidence(evidenceId)],
});

/** 2026-09-19 11:00 JST — inside the 11:00-20:00 listed window used across these cases. */
const NOW = Date.parse('2026-09-19T02:00:00Z');
const at = (jstHour: number, minute = 0): string =>
  `2026-09-19T${String(jstHour - 9).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;

const hours = (overrides: Partial<OpeningHours> = {}): OpeningHours => ({
  timeZone: 'Asia/Tokyo',
  intervals: [{ startAt: at(11), endAt: at(20) }],
  weeklyText: ['月〜日: 11:00〜20:00'],
  evaluatedAt: at(11),
  listedOpenAtEvaluation: true,
  nextBoundaryAt: at(20),
  lastOrderAt: at(19, 30),
  lastOrderRaw: null,
  ...overrides,
});

const card = (facts: Partial<PublicCard['facts']> = {}): PublicCard => ({
  candidateId: 'candidate-1',
  facts: {
    identity: known({
      name: 'ミスターフレンドリー 恵比寿店',
      area: '恵比寿',
      address: null,
      category: 'カフェ・スイーツ',
      stationName: '恵比寿',
      accessText: 'ＪＲ恵比寿駅 西口から徒歩3分',
      businessStatus: 'operational' as const,
      sourceUrl: null,
    }),
    ...facts,
  },
  why: { text: '寄りやすい', evidenceIds: [], evidence: [], basis: 'grounded', retention },
});

const photos = known({ photos: [{ photoToken: 'token-1', attributions: [], sourceUrl: null }] });

describe('candidate detail facts', () => {
  it.each([null, 'https://www.hotpepper.jp/strJ000000001/?vos=nhppalsa000016'])(
    'shares the card URL without changing it or substituting credits: %s',
    (sourceUrl) => {
      const identity = card().facts.identity;
      if (identity.status !== 'known') throw new Error('known fixture required');
      const source = card({
        identity: known({ ...identity.value, sourceUrl }),
        opening_hours: known(hours()),
      });
      for (const now of [NOW, Date.parse(at(21))]) {
        const view = toCandidateDetailViewModel(source, now);
        expect(view.sourceUrl).toBe(sourceUrl);
        expect(view.sourceUrl).toBe(toCardViewModel(source, now).sourceUrl);
      }
    },
  );

  it.each([
    { status: 'unknown', reason: 'not supplied' },
    { status: 'unsupported', reason: 'not supported' },
    { status: 'not_applicable', reason: 'not applicable' },
    { status: 'error', code: 'PROVIDER_UNAVAILABLE', reason: 'down' },
  ] as const)('omits the URL for $status identity even if other facts have credits', (identity) => {
    const source = card({ identity, opening_hours: known(hours()) });
    const view = toCandidateDetailViewModel(source, NOW);
    expect(view.attributions.length).toBeGreaterThan(0);
    expect(view.sourceUrl).toBeNull();
    expect(view.sourceUrl).toBe(toCardViewModel(source, NOW).sourceUrl);
  });

  it('uses the same photo and typographic decisions as the card', () => {
    expect(toCandidateDetailViewModel(card({ photos }), NOW).visual).toBe('photo');
    expect(toCandidateDetailViewModel(card(), NOW).visual).toBe('typographic');
    expect(toCandidateDetailViewModel(card({ photos: known({ photos: [] }) }), NOW).visual).toBe(
      'typographic',
    );
  });

  it.each([[], ['月〜金 11:00〜20:00'], ['月〜金 11:00〜20:00', '定休日: 土日']])(
    'preserves every published schedule entry: %j',
    (...weeklyText: string[]) => {
      const view = toCandidateDetailViewModel(
        card({ opening_hours: known(hours({ weeklyText })) }),
        NOW,
      );
      expect(view.hours).toEqual(weeklyText);
      expect(detailSections(view).some((section) => section.label === '営業時間')).toBe(
        weeklyText.length > 0,
      );
    },
  );

  it('retains full access, address and raw price, normalizing width without truncation', () => {
    const base = card();
    const identity = base.facts.identity;
    if (identity?.status !== 'known') throw new Error('known fixture required');
    const access = 'ＪＲ恵比寿駅 西口から交差点を渡り、長い坂道の先の建物２Ｆ';
    const view = toCandidateDetailViewModel(
      card({
        identity: known({
          ...identity.value,
          accessText: access,
          address: '渋谷区ＡＢＣ１−２',
          stationName: '恵比寿',
        }),
        price: known({ level: null, range: null, rawLabel: '２００１〜３０００円' }),
      }),
      NOW,
    );
    expect(view).toMatchObject({
      access: 'JR恵比寿駅 西口から交差点を渡り、長い坂道の先の建物2F',
      address: '渋谷区ABC1−2',
      station: '恵比寿',
      price: '2001〜3000円',
    });
  });

  it('omits absent and unavailable fields without placeholder sections', () => {
    const view = toCandidateDetailViewModel(
      card({
        identity: { status: 'unknown', reason: 'not provided' },
        price: { status: 'error', code: 'PROVIDER_UNAVAILABLE', reason: 'failed' },
        facilities: { status: 'unsupported', reason: 'unavailable' },
      }),
      NOW,
    );
    expect(view).toMatchObject({
      name: '候補',
      category: null,
      station: null,
      access: null,
      address: null,
      price: null,
      hours: [],
      facilities: [],
      facilityNotes: [],
      opening: { kind: 'none' },
    });
    expect(detailSections(view)).toEqual([]);
  });

  it('does not substitute a numeric price range for the requested raw label', () => {
    const view = toCandidateDetailViewModel(
      card({
        price: known({
          level: 2,
          rawLabel: null,
          range: { min: 1000, max: 2000, currency: 'JPY', unit: 'per_person' },
        }),
      }),
      NOW,
    );
    expect(view.price).toBeNull();
  });

  it('keeps negative and partial facilities and at most four full provider notes', () => {
    const view = toCandidateDetailViewModel(
      card({
        facilities: known({
          nonSmoking: 'partial',
          wifi: 'yes',
          privateRoom: 'no',
          parking: 'unknown',
          sourceText: [
            'なし ：目の前にコインパーキングあります！',
            'Ｗｉ−Ｆｉ',
            '補足３',
            '補足４',
            '補足５',
          ],
        }),
      }),
      NOW,
    );
    expect(view.facilities).toEqual([
      { label: '全面禁煙', value: 'partial' },
      { label: 'Wi-Fi', value: 'yes' },
      { label: '個室', value: 'no' },
    ]);
    expect(view.facilityNotes).toEqual([
      'なし :目の前にコインパーキングあります!',
      'Wi−Fi',
      '補足3',
      '補足4',
    ]);
    expect(detailSections(view).find((section) => section.label === '設備')?.lines).toContain(
      '個室：なし',
    );
  });

  it('omits an all-unknown facilities list but keeps available provider notes', () => {
    const view = toCandidateDetailViewModel(
      card({
        facilities: known({
          nonSmoking: 'unknown',
          wifi: 'unknown',
          privateRoom: 'unknown',
          parking: 'unknown',
          sourceText: ['店舗にお問い合わせください'],
        }),
      }),
      NOW,
    );
    expect(view.facilities).toEqual([]);
    expect(view.facilityNotes).toEqual(['店舗にお問い合わせください']);
  });

  it.each([
    'expired',
    'policy_withheld',
    'attribution_missing',
    'disabled_capability',
    'disabled_m35',
  ] as const)(
    'drops an entire field and its credits when any evidence is %s',
    (displayPolicyStatus) => {
      const base = card();
      const identity = base.facts.identity;
      if (identity?.status !== 'known') throw new Error('known fixture required');
      const denied = { ...evidence('denied'), retention: { ...retention, displayPolicyStatus } };
      const view = toCandidateDetailViewModel(
        card({
          identity: {
            ...identity,
            value: { ...identity.value, sourceUrl: 'https://www.hotpepper.jp/strJ000000001/' },
            evidence: [evidence('ok'), denied],
          },
          photos: { ...photos, evidence: [denied] },
          opening_hours: { ...known(hours()), evidence: [denied] },
          facilities: {
            ...known({
              nonSmoking: 'yes' as const,
              wifi: 'yes' as const,
              privateRoom: 'no' as const,
              parking: 'partial' as const,
              sourceText: ['秘密'],
            }),
            evidence: [denied],
          },
          price: { ...known({ level: null, range: null, rawLabel: '秘密' }), evidence: [denied] },
        }),
        NOW,
      );
      expect(view).toMatchObject({
        name: '候補',
        sourceUrl: null,
        visual: 'typographic',
        opening: { kind: 'none' },
        hours: [],
        station: null,
        access: null,
        address: null,
        price: null,
        facilities: [],
        facilityNotes: [],
        attributions: [],
      });
    },
  );

  it('does not use explanation credits to enable a sheet without fact credits', () => {
    const base = card({ identity: { status: 'unknown', reason: 'absent' } });
    expect(
      toCandidateDetailViewModel(
        { ...base, why: { ...base.why, evidence: [evidence('why')] } },
        NOW,
      ).attributions,
    ).toEqual([]);
  });

  it('deduplicates fact credits while preserving photo author attribution', () => {
    const view = toCandidateDetailViewModel(
      card({
        opening_hours: known(hours()),
        photos: known({
          photos: [
            {
              photoToken: 'token-1',
              sourceUrl: null,
              attributions: [{ displayName: '撮影者', uri: 'https://example.com/author' }],
            },
          ],
        }),
      }),
      NOW,
    );
    expect(view.attributions).toEqual([
      { label: 'ホットペッパー グルメ', sourceLink: 'https://example.com/shop' },
      { label: '撮影者', sourceLink: 'https://example.com/author' },
    ]);
  });
});

describe('detail opening and actions', () => {
  it('shares the exact card opening threshold and swaps actions only while closed', () => {
    const source = card({ opening_hours: known(hours()) });
    for (const now of [
      NOW,
      Date.parse(at(20)) - CLOSING_SOON_MINUTES * 60_000,
      Date.parse(at(21)),
    ]) {
      const view = toCandidateDetailViewModel(source, now);
      expect(view.opening).toEqual(toCardViewModel(source, now).opening);
      const closed = view.opening.kind === 'closed';
      expect(view.dimmed).toBe(closed);
      expect(view.primaryAction).toBe(closed ? 'save' : 'decide');
      expect(detailActions(view).map((action) => action.kind)).toEqual(
        closed ? ['save', 'decide'] : ['decide', 'save'],
      );
    }
  });

  it('does not infer open or closed from unparsed hours', () => {
    const view = toCandidateDetailViewModel(
      card({ opening_hours: known(hours({ nextBoundaryAt: null })) }),
      NOW,
    );
    expect(view.opening.kind).toBe('listed');
    expect(view.primaryAction).toBe('decide');
    expect(view.dimmed).toBe(false);
  });
});

describe('detail reads already loaded card photos', () => {
  const client = {};
  const image: ReadyPhotoImage = {
    status: 'ready',
    client,
    token: 'token-1',
    displayUntil: new Date(retention.displayUntil).toISOString(),
    asset: {
      uri: 'data:image/png;base64,AAAA',
      contentType: 'image/png',
      expiresAt: '2026-09-19T03:00:00Z',
    },
  };

  it('returns the same in-memory image only for its current identity', () => {
    const source = card({ photos });
    expect(candidateDetailPhotos(source, [image], client, NOW)[0]).toBe(image);
    expect(candidateDetailPhotos(source, [], client, NOW)).toEqual([]);
    expect(candidateDetailPhotos(source, [image], {}, NOW)).toEqual([]);
    expect(candidateDetailPhotos(source, [image], undefined, NOW)).toEqual([]);
    expect(candidateDetailPhotos(source, [{ ...image, token: 'other' }], client, NOW)).toEqual([]);
    expect(candidateDetailPhotos(source, [{ ...image, displayUntil: null }], client, NOW)).toEqual(
      [],
    );
  });

  it('drops an image at expiry and when photo facts are withheld', () => {
    expect(
      candidateDetailPhotos(card({ photos }), [image], client, Date.parse(image.asset.expiresAt)),
    ).toEqual([]);
    const hidden = {
      ...photos,
      evidence: [
        {
          ...evidence('photo'),
          retention: { ...retention, displayPolicyStatus: 'expired' as const },
        },
      ],
    };
    expect(candidateDetailPhotos(card({ photos: hidden }), [image], client, NOW)).toEqual([]);
    expect(candidateDetailPhotos(card(), [image], client, NOW)).toEqual([]);
  });

  it('shares only the selected card image when all three thumbnails have loaded', () => {
    const second: ReadyPhotoImage = {
      ...image,
      token: 'token-2',
      asset: { ...image.asset, uri: 'data:image/png;base64,BBBB' },
    };
    const third: ReadyPhotoImage = {
      ...image,
      token: 'token-3',
      asset: { ...image.asset, uri: 'data:image/png;base64,CCCC' },
    };
    const source = {
      ...card({
        photos: known({ photos: [{ photoToken: 'token-2', sourceUrl: null, attributions: [] }] }),
      }),
      candidateId: 'candidate-2',
    };
    expect(candidateDetailPhotos(source, [image, second, third], client, NOW)).toEqual([second]);
  });
});
