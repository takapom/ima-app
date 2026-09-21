import { describe, expect, it } from 'vitest';
import type { EvidenceRef, OpeningHours, PublicCard } from '@ima/contracts';
import {
  CLOSING_SOON_MINUTES,
  cardActions,
  cardOpeningSummary,
  cardRenderNow,
  toCardViewModel,
} from '@mobile/journey/presentation/candidate-card-view';

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

describe('card source URL', () => {
  const sourceUrl = 'https://www.hotpepper.jp/strJ000000001/?vos=nhppalsa000016';
  const linkedCard = (): PublicCard => {
    const identity = card().facts.identity;
    if (identity.status !== 'known') throw new Error('known fixture required');
    return card({ identity: known({ ...identity.value, sourceUrl }) });
  };

  it('keeps the full identity URL including its query, even while closed', () => {
    const source = linkedCard();
    expect(toCardViewModel(source, NOW).sourceUrl).toBe(sourceUrl);
    const closed = toCardViewModel(
      card({ ...source.facts, opening_hours: known(hours()) }),
      Date.parse(at(21)),
    );
    expect(closed.opening.kind).toBe('closed');
    expect(closed.sourceUrl).toBe(sourceUrl);
  });

  it('does not substitute attribution or photo URLs for a missing identity URL', () => {
    const source = card({
      photos: known({
        photos: [{ photoToken: 'token-1', attributions: [], sourceUrl }],
      }),
    });
    expect(toCardViewModel(source, NOW).sourceUrl).toBeNull();
  });

  it.each([
    { status: 'unknown', reason: 'not supplied' },
    { status: 'unsupported', reason: 'not supported' },
    { status: 'not_applicable', reason: 'not applicable' },
    { status: 'error', code: 'PROVIDER_UNAVAILABLE', reason: 'down' },
  ] as const)('omits the URL for $status identity', (identity) => {
    expect(toCardViewModel(card({ identity }), NOW).sourceUrl).toBeNull();
  });

  it.each([
    'expired',
    'policy_withheld',
    'attribution_missing',
    'disabled_capability',
    'disabled_m35',
  ] as const)(
    'removes a previously visible URL when any evidence becomes %s',
    (displayPolicyStatus) => {
      const source = linkedCard();
      const identity = source.facts.identity;
      if (identity.status !== 'known') throw new Error('known fixture required');
      expect(toCardViewModel(source, NOW).sourceUrl).toBe(sourceUrl);
      const hidden = card({
        identity: {
          ...identity,
          evidence: [
            ...identity.evidence,
            { ...evidence('denied'), retention: { ...retention, displayPolicyStatus } },
          ],
        },
      });
      expect(toCardViewModel(hidden, NOW).sourceUrl).toBeNull();
    },
  );
});

describe('card visual', () => {
  it('uses the photo treatment only when a photo is actually present', () => {
    expect(toCardViewModel(card({ photos }), NOW).visual).toBe('photo');
  });

  it('falls back to the typographic treatment instead of an empty photo frame', () => {
    expect(toCardViewModel(card(), NOW).visual).toBe('typographic');
    expect(
      toCardViewModel(
        card({ photos: { status: 'error', code: 'PROVIDER_UNAVAILABLE', reason: 'down' } }),
        NOW,
      ).visual,
    ).toBe('typographic');
    expect(toCardViewModel(card({ photos: known({ photos: [] }) }), NOW).visual).toBe(
      'typographic',
    );
  });

  it('drops a photo whose evidence is no longer displayable', () => {
    const expired = {
      status: 'known' as const,
      value: { photos: [{ photoToken: 'token-1', attributions: [], sourceUrl: null }] },
      evidence: [
        {
          ...evidence('photo-1'),
          retention: { ...retention, displayPolicyStatus: 'expired' as const },
        },
      ],
    };
    expect(toCardViewModel(card({ photos: expired }), NOW).visual).toBe('typographic');
  });
});

describe('card opening state', () => {
  it('keeps compact hours factual and highlights closing without inventing a current status', () => {
    expect(cardOpeningSummary({ kind: 'none' })).toBeNull();
    expect(
      cardOpeningSummary({
        kind: 'open',
        closesAtLabel: '20:00',
        remainingMinutes: 90,
        lastOrderLabel: '料理19:30',
      }),
    ).toBe('20:00まで営業 · L.O. 料理19:30');
    expect(cardOpeningSummary({ kind: 'listed', text: '月〜金 11:00〜20:00' })).toBe(
      '掲載：月〜金 11:00〜20:00',
    );
    expect(cardOpeningSummary({ kind: 'closed', reopensAtLabel: null })).toBe('営業時間外');
    expect(cardOpeningSummary({ kind: 'closed', reopensAtLabel: '明日 11:00' })).toBe(
      '明日 11:00から営業',
    );
    expect(
      cardOpeningSummary({
        kind: 'open',
        closesAtLabel: '20:00',
        remainingMinutes: 90,
        lastOrderLabel: null,
      }),
    ).toBe('20:00まで営業');
    expect(
      cardOpeningSummary({
        kind: 'closing',
        closesAtLabel: '20:00',
        remainingMinutes: 15,
        lastOrderLabel: null,
      }),
    ).toBe('あと15分で閉店 · 20:00まで');
  });
  it('reports the remaining time from the render clock, not from evaluatedAt', () => {
    // evaluatedAt is 11:00 and says "open"; reading the card at 19:15 must still count down
    // to the 20:00 boundary rather than echo the snapshot taken eight hours earlier.
    const stale = hours({ evaluatedAt: at(11), listedOpenAtEvaluation: true });
    const opening = toCardViewModel(
      card({ opening_hours: known(stale) }),
      Date.parse(at(19, 15)),
    ).opening;
    expect(opening).toMatchObject({ kind: 'open', closesAtLabel: '20:00', remainingMinutes: 45 });
  });

  it('stays open while more than the closing threshold remains', () => {
    const opening = toCardViewModel(card({ opening_hours: known(hours()) }), NOW).opening;
    expect(opening).toMatchObject({
      kind: 'open',
      closesAtLabel: '20:00',
      remainingMinutes: 540,
      lastOrderLabel: '19:30',
    });
  });

  it('escalates exactly at the closing threshold', () => {
    const boundary = Date.parse(at(20)) - CLOSING_SOON_MINUTES * 60_000;
    expect(
      toCardViewModel(card({ opening_hours: known(hours()) }), boundary).opening,
    ).toMatchObject({ kind: 'closing', remainingMinutes: CLOSING_SOON_MINUTES });
    expect(
      toCardViewModel(card({ opening_hours: known(hours()) }), boundary - 60_000).opening,
    ).toMatchObject({ kind: 'open', remainingMinutes: CLOSING_SOON_MINUTES + 1 });
  });

  it('prefers the provider last-order text over the parsed instant', () => {
    const opening = toCardViewModel(
      card({ opening_hours: known(hours({ lastOrderRaw: '料理19:00 ドリンク19:30' })) }),
      NOW,
    ).opening;
    expect(opening).toMatchObject({ lastOrderLabel: '料理19:00 ドリンク19:30' });
  });

  it('reports closed with the next opening, labelled by day', () => {
    const overnight = hours({ nextBoundaryAt: '2026-09-20T02:00:00Z' });
    const opening = toCardViewModel(
      card({ opening_hours: known(overnight) }),
      Date.parse(at(21)),
    ).opening;
    expect(opening).toEqual({ kind: 'closed', reopensAtLabel: '明日 11:00' });
  });

  it('keeps an open-ended interval open past the hour it would otherwise close', () => {
    const allDay = hours({
      intervals: [{ startAt: at(11), endAt: null }],
      nextBoundaryAt: '2026-09-20T02:00:00Z',
    });
    expect(
      toCardViewModel(card({ opening_hours: known(allDay) }), Date.parse(at(23))).opening,
    ).toMatchObject({ kind: 'open', remainingMinutes: 720 });
  });

  it('shows the listed text as published when the hours were never parsed', () => {
    const unparsed = hours({ nextBoundaryAt: null });
    expect(toCardViewModel(card({ opening_hours: known(unparsed) }), NOW).opening).toEqual({
      kind: 'listed',
      text: '月〜日: 11:00〜20:00',
    });
  });

  it('reports no opening state rather than inventing one', () => {
    expect(toCardViewModel(card(), NOW).opening).toEqual({ kind: 'none' });
    expect(
      toCardViewModel(
        card({ opening_hours: known(hours({ nextBoundaryAt: null, weeklyText: [] })) }),
        NOW,
      ).opening,
    ).toEqual({ kind: 'none' });
    expect(
      toCardViewModel(card({ opening_hours: { status: 'unknown', reason: 'not requested' } }), NOW)
        .opening,
    ).toEqual({ kind: 'none' });
  });
});

describe('card action and emphasis', () => {
  it('keeps 見てみる in the peek slot and emphasizes 残す only when closed', () => {
    const open = toCardViewModel(card({ opening_hours: known(hours()) }), NOW);
    expect(open).toMatchObject({ primaryAction: 'details', dimmed: false });
    expect(cardActions(open)).toEqual({
      peek: {
        label: '見てみる',
        accessibilityLabel: 'ミスターフレンドリー 恵比寿店を見てみる',
      },
      save: {
        emphasized: false,
        accessibilityLabel: 'ミスターフレンドリー 恵比寿店を残す',
      },
    });

    const closed = toCardViewModel(card({ opening_hours: known(hours()) }), Date.parse(at(21)));
    expect(closed).toMatchObject({ primaryAction: 'save', dimmed: true });
    expect(cardActions(closed)).toEqual({
      peek: {
        label: '見てみる',
        accessibilityLabel: 'ミスターフレンドリー 恵比寿店を見てみる',
      },
      save: {
        emphasized: true,
        accessibilityLabel: 'ミスターフレンドリー 恵比寿店を残す',
      },
    });
  });

  it('keeps peek available when the hours are unknown', () => {
    const view = toCardViewModel(card(), NOW);
    expect(view).toMatchObject({
      primaryAction: 'details',
      dimmed: false,
    });
    expect(cardActions(view).peek.label).toBe('見てみる');
    expect(cardActions(view).save.emphasized).toBe(false);
  });
});

describe('card fact lines', () => {
  it('evens out full-width Latin in the provider access text', () => {
    expect(toCardViewModel(card(), NOW).access).toBe('JR恵比寿駅 西口から徒歩3分');
  });

  it('prefers a measured walking route over the listed access text', () => {
    const route = known({
      originRef: 'origin-1',
      destinationCandidateId: 'candidate-1',
      originRevision: 1,
      evaluatedAt: at(11),
      durationSeconds: 260,
      distanceMeters: 300,
      warnings: [],
    });
    expect(toCardViewModel(card({ walking_route: route }), NOW).access).toBe('恵比寿駅から徒歩4分');
  });

  it('omits the line entirely when nothing about access is known', () => {
    const bare = card({
      identity: known({
        name: '恵比寿 焙煎所',
        area: '恵比寿',
        address: null,
        category: 'カフェ',
        stationName: null,
        accessText: null,
        businessStatus: 'operational' as const,
        sourceUrl: null,
      }),
    });
    expect(toCardViewModel(bare, NOW).access).toBeNull();
  });

  it('uses the provider price label and never a bare level', () => {
    expect(
      toCardViewModel(
        card({ price: known({ level: null, range: null, rawLabel: '２００１〜３０００円' }) }),
        NOW,
      ).price,
    ).toBe('2001〜3000円');
    expect(
      toCardViewModel(card({ price: known({ level: 2, range: null, rawLabel: null }) }), NOW).price,
    ).toBeNull();
  });

  it('formats an explicit range when the provider gave no label', () => {
    const range = known({
      level: null,
      range: { currency: 'JPY', min: 2001, max: 3000, unit: 'per_person' as const },
      rawLabel: null,
    });
    expect(toCardViewModel(card({ price: range }), NOW).price).toBe('2,001〜3,000円/人');
  });

  it('turns only affirmed facilities into chips', () => {
    const facilities = known({
      wifi: 'yes' as const,
      nonSmoking: 'partial' as const,
      privateRoom: 'unknown' as const,
      parking: 'no' as const,
      sourceText: [],
    });
    expect(toCardViewModel(card({ facilities }), NOW).amenities).toEqual(['分煙', 'Wi-Fi']);
    expect(toCardViewModel(card(), NOW).amenities).toEqual([]);
  });

  it('withholds the diff when its evidence is no longer displayable', () => {
    const base = card();
    const shown: PublicCard = {
      ...base,
      diff: {
        text: 'もう少し遅くまで',
        evidenceIds: [],
        evidence: [],
        basis: 'grounded',
        retention,
      },
    };
    expect(toCardViewModel(shown, NOW).diff).toBe('もう少し遅くまで');

    const hidden: PublicCard = {
      ...base,
      diff: {
        text: 'もう少し遅くまで',
        evidenceIds: [],
        evidence: [],
        basis: 'grounded',
        retention: { ...retention, displayPolicyStatus: 'policy_withheld' },
      },
    };
    expect(toCardViewModel(hidden, NOW).diff).toBeNull();
  });
});

describe('render clock', () => {
  it('uses the injected time when a host supplies one', () => {
    expect(cardRenderNow('2026-09-19T02:00:00Z')).toBe(NOW);
  });

  it('falls back to the device clock for an absent or unparsable value', () => {
    const before = Date.now();
    expect(cardRenderNow(undefined)).toBeGreaterThanOrEqual(before);
    expect(cardRenderNow('not-a-timestamp')).toBeGreaterThanOrEqual(before);
  });
});
