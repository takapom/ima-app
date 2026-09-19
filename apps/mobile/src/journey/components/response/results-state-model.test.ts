import { describe, expect, it } from 'vitest';
import type { CardsData, PublicCard } from '@ima/contracts';
import type {
  AssistantMessageRecord,
  CardSetDisplayState,
} from '@mobile/journey/state/assistant-response';
import {
  buildMessageHistory,
  cardSetStatusLabel,
  orderedResultCards,
} from '@mobile/journey/components/response/results-state-model';

const message = (text: string) => ({
  text,
  evidenceIds: [],
  evidence: [],
  basis: 'conversational' as const,
  retention: {
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
  },
});

const record = (
  responseId: string,
  revision: number,
  cardSetId: string | null,
  text: string,
): AssistantMessageRecord => ({
  responseId,
  turnId: 'turn-1',
  revision,
  declaredCardSetId: cardSetId,
  cardSetId,
  message: message(text),
});

describe('results state model', () => {
  const candidate = (candidateId: string): PublicCard => ({
    candidateId,
    facts: { identity: { status: 'unknown', reason: '表示順序のfixture' } },
    why: { ...message('提案理由'), basis: 'grounded' },
  });
  const cards: CardsData = {
    hero: candidate('first'),
    alts: [candidate('second'), candidate('third')],
  };

  it('returns all three candidates in proposal order with their own data intact', () => {
    const result = orderedResultCards(cards, undefined);
    expect(result.map((card) => card.candidateId)).toEqual(['first', 'second', 'third']);
    expect(result[0]).toBe(cards.hero);
    expect(result[1]).toBe(cards.alts[0]);
    expect(result[2]).toBe(cards.alts[1]);
  });

  it('keeps the current selection order and does not reintroduce excluded or missing cards', () => {
    expect(
      orderedResultCards(cards, ['third', 'missing', 'first']).map((card) => card.candidateId),
    ).toEqual(['third', 'first']);
    expect(orderedResultCards(cards, [])).toEqual([]);
    expect(orderedResultCards({ hero: cards.hero, alts: [] }, undefined)).toEqual([cards.hero]);
  });
  it('shows a clarification message without a misleading empty-card label', () => {
    expect(
      cardSetStatusLabel({ kind: 'empty', reason: 'no_cards', responseId: 'question' }, true),
    ).toBeNull();
    expect(
      cardSetStatusLabel({ kind: 'empty', reason: 'reference_only', responseId: 'question' }, true),
    ).toBe('過去の候補を復元できませんでした。');
  });
  it('keeps message order and marks current, past, and cardless relations', () => {
    const items = buildMessageHistory(
      [
        record('response-old', 1, 'cards-old', '前の候補'),
        record('response-current', 2, 'cards-current', '今回の候補'),
        record('response-message', 3, null, '候補なし'),
      ],
      'cards-current',
      true,
    );

    expect(items.map((item) => [item.responseId, item.relation])).toEqual([
      ['response-old', 'past'],
      ['response-current', 'current'],
      ['response-message', 'none'],
    ]);
    expect(items.map((item) => item.key)).toEqual([
      'response-old:1:0',
      'response-current:2:1',
      'response-message:3:2',
    ]);
  });

  it('does not call an unrendered card set current when payload is absent', () => {
    const items = buildMessageHistory(
      [record('response-old', 1, 'cards-old', '過去')],
      null,
      false,
    );

    expect(items[0]?.relation).toBe('past');
  });

  it('suppresses message text when the public retention projection is unavailable', () => {
    const expiredMessage = message('期限切れの本文');
    const expiredRecord: AssistantMessageRecord = {
      ...record('response-expired', 1, null, expiredMessage.text),
      message: {
        ...expiredMessage,
        retention: {
          ...expiredMessage.retention,
          policyStatus: 'expired',
          displayPolicyStatus: 'expired',
        },
      },
    };

    const items = buildMessageHistory([expiredRecord], null, false);

    expect(items[0]?.displayPolicyStatus).toBe('expired');
    expect(items[0]?.message).toBeNull();
  });

  it('labels kept and unavailable card-set states without inventing card facts', () => {
    const states: readonly [CardSetDisplayState, string | null][] = [
      [{ kind: 'available', responseId: 'response-1', sourceRevision: 1 }, null],
      [
        {
          kind: 'kept',
          responseId: 'response-2',
          sourceResponseId: 'response-1',
          sourceRevision: 1,
        },
        '前の候補を表示中',
      ],
      [
        { kind: 'empty', reason: 'no_cards', responseId: 'response-3' },
        '候補はまだ提示されていません。',
      ],
      [
        { kind: 'empty', reason: 'reference_only', responseId: 'response-4' },
        '過去の候補を復元できませんでした。',
      ],
      [
        { kind: 'empty', reason: 'unavailable', responseId: 'response-5' },
        '過去の候補は現在表示できません。',
      ],
    ];

    for (const [state, label] of states) expect(cardSetStatusLabel(state)).toBe(label);
  });
});
