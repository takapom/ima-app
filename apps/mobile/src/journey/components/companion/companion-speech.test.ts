import { describe, expect, it } from 'vitest';
import type { PublicCard } from '@ima/contracts';
import { companionSpeech } from '@mobile/journey/components/companion/companion-speech';
import type { FocusedCard } from '@mobile/journey/state/card-set-focus';

const retention = (displayPolicyStatus: 'available' | 'expired') => ({
  retentionDecision: 'deny' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: '2026-10-07T00:00:00Z',
  freshUntil: '2026-10-07T00:00:00Z',
  displayUntil: '2026-10-07T00:00:00Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only' as const,
  policyStatus: 'policy_withheld' as const,
  displayPolicyStatus,
});

const card = (why: string, status: 'available' | 'expired' = 'available'): PublicCard => ({
  candidateId: 'cafe',
  facts: { identity: { status: 'unknown', reason: 'fixture' } },
  why: { text: why, retention: retention(status) },
});

const focused = (overrides: Partial<FocusedCard>): FocusedCard => ({
  id: 'answer',
  card: card('駅徒歩2分。ソファ席完備と掲載され、静かめの利用に合いそうです'),
  index: 0,
  count: 3,
  latest: true,
  ...overrides,
});

describe('companion speech', () => {
  it('has nothing to say without a card in view', () => {
    expect(companionSpeech(null)).toBeNull();
  });

  it('reads the reason word for word with which card of the newest answer it is', () => {
    expect(companionSpeech(focused({ index: 1 }))).toEqual({
      text: '駅徒歩2分。ソファ席完備と掲載され、静かめの利用に合いそうです',
      position: '2 / 3',
      relation: '今回の提案',
    });
  });

  it('says the card belongs to an earlier answer when an older answer is in view', () => {
    expect(companionSpeech(focused({ latest: false }))?.relation).toBe('前の提案');
  });

  it('leaves out the position when the answer has a single card', () => {
    expect(companionSpeech(focused({ count: 1 }))?.position).toBeNull();
  });

  it('says the reason has expired instead of showing an expired reason', () => {
    expect(companionSpeech(focused({ card: card('古い理由', 'expired') }))?.text).toBe(
      'この説明は表示期限を過ぎています。',
    );
  });
});
