import { describe, expect, it } from 'vitest';
import { createModelContext } from './fixtures';
import { encodeModelContext } from '@worker/runtime/model/encoding';
import { MODEL_SYSTEM_PROMPT } from '@worker/runtime/model/system-prompt';

describe('model message encoding', () => {
  it('keeps the original mixed-intent request and only sends projected context', () => {
    const context = createModelContext();
    const messages = encodeModelContext(context);

    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(MODEL_SYSTEM_PROMPT);
    expect(messages[0]?.content).toContain('推測・未確認の事項');
    expect(messages[0]?.content).toContain('final_message');
    expect(messages[0]?.content).toContain('submit_cards');
    expect(messages[1]?.content).toContain('なぜ二つ目？ もう少し近く、静かさは維持して。');
    expect(messages[1]?.content).not.toContain('35.6');
    expect(messages[1]?.content).not.toContain('139.7');
    expect(messages[1]?.content).not.toContain('ownerScopeRef');
    expect(messages[1]?.content).not.toContain('owner-1');
  });

  it('orders intent, clarification, and recommendation before tool and output rules', () => {
    expect(MODEL_SYSTEM_PROMPT.match(/^## .+$/gm)).toEqual([
      '## 判断手順',
      '## 終端の選び方',
      '## 各Toolの規則',
      '## 出力の禁止事項',
    ]);
    expect(MODEL_SYSTEM_PROMPT).toMatch(/1\. 原文とこれまでの会話[\s\S]*2\. 場所[\s\S]*3\. 要望/);
    expect(MODEL_SYSTEM_PROMPT).toContain('店舗を提案せずfinal_messageで必要な質問を原則1つ');
    expect(MODEL_SYSTEM_PROMPT).toContain('店舗カードと選定理由をセットで返してください');
  });

  it('reserves the last model call for a final message without tools', () => {
    expect(MODEL_SYSTEM_PROMPT).toContain(
      'budget.modelCallsRemainingが1のときはToolを呼ばず、final_messageで現状を返してください',
    );
    expect(MODEL_SYSTEM_PROMPT).toContain('カード提示より予算制約を優先');
  });

  it('specifies Japanese output and distinguishes card and final message text limits', () => {
    expect(MODEL_SYSTEM_PROMPT).toContain('ユーザーへの回答は日本語');
    expect(MODEL_SYSTEM_PROMPT).toContain('whyが80字');
    expect(MODEL_SYSTEM_PROMPT).toContain('diffが40字');
    expect(MODEL_SYSTEM_PROMPT).toContain('submit_cardsのmessageは各300字で最大4件');
    expect(MODEL_SYSTEM_PROMPT).toContain(
      'final_messageのmessageは配列ではなく1件の文字列で、300字以内',
    );
  });

  it('keeps terminal formatting and unsupported constraint safeguards', () => {
    expect(MODEL_SYSTEM_PROMPT).toContain(
      'Toolを呼ぶstepには文章を書かないでください。「探します」のような前置きは破棄され、終端としては扱いません。終端を返すstepではToolを呼ばず、final_messageのenvelopeかsubmit_cardsのどちらかだけを出してください。空の応答で終わらないでください。',
    );
    expect(MODEL_SYSTEM_PROMPT).toContain('徒歩時間・終電・滞在可能時間は取得できません');
    expect(MODEL_SYSTEM_PROMPT).not.toContain('turnConstraints');
    expect(MODEL_SYSTEM_PROMPT).not.toContain('駅directory');
  });

  it('leaves provider search and card preparation instructions in tool descriptions', () => {
    expect(MODEL_SYSTEM_PROMPT).not.toContain('空白区切りのAND検索');
    expect(MODEL_SYSTEM_PROMPT).not.toContain('1st step');
    expect(MODEL_SYSTEM_PROMPT).toContain('各Toolのdescriptionに従ってください');
  });

  it('describes the plain-text final message and asks for uncertainty in the text itself', () => {
    const [system] = encodeModelContext(createModelContext());
    expect(system?.content).toContain('{"kind":"final_message","message":"確認しました"}');
    expect(system?.content).toContain('文章の中で区別してください');
    expect(system?.content).not.toContain('evidenceIds');
    expect(system?.content).not.toContain('basis');
    expect(system?.content).not.toContain('sourceTurnId');
    expect(system?.content).not.toContain('metadata');
  });

  it('orders the envelope from stable to volatile and summarizes evidence without internals', () => {
    const context = createModelContext();
    const known = {
      status: 'known' as const,
      observationId: 'observation-secret',
      candidateId: 'candidate-1',
      field: 'identity' as const,
      value: {
        name: '店A',
        area: '恵比寿',
        address: null,
        category: 'cafe',
        stationName: '恵比寿',
        accessText: '徒歩3分',
        businessStatus: 'operational',
        sourceUrl: 'https://example.com/shop',
      },
      fetchedAt: '2026-09-10T11:00:00Z',
      freshUntil: '2026-09-10T12:30:00Z',
      expiresAt: '2026-09-10T20:00:00Z',
      sources: [{ provider: 'fixture-provider', attribution: null, publicUrl: null }],
    };
    const stale = {
      status: 'stale' as const,
      observationId: 'observation-stale',
      candidateId: 'candidate-1',
      field: 'opening_hours' as const,
      reason: 'expired',
      freshUntil: '2026-09-10T11:30:00Z',
    };
    const [, user] = encodeModelContext({
      ...context,
      history: [
        { turnId: 'turn-1', role: 'user', text: '静かで甘いものがある店' },
        { turnId: 'turn-2', role: 'assistant', text: '候補を3つ出しました。' },
      ],
      evidence: [known, stale],
    });
    if (typeof user?.content !== 'string') throw new Error('context message must be text');
    const serialized = user.content;
    const envelope = JSON.parse(serialized) as {
      readonly context: Record<string, unknown>;
    };
    expect(Object.keys(envelope)).toEqual(['kind', 'context', 'originalUserText']);
    expect(Object.keys(envelope.context)).toEqual([
      'capabilities',
      'preferences',
      'history',
      'cardSet',
      'evidence',
      'location',
      'serverNow',
      'budget',
    ]);
    expect(envelope.context.evidence).toEqual([
      {
        candidateId: 'candidate-1',
        field: 'identity',
        status: 'known',
        name: '店A',
        category: 'cafe',
        area: '恵比寿',
        address: null,
        stationName: '恵比寿',
        accessText: '徒歩3分',
        businessStatus: 'operational',
      },
      { candidateId: 'candidate-1', field: 'opening_hours', status: 'stale' },
    ]);
    expect(envelope.context.history).toEqual([
      { role: 'user', text: '静かで甘いものがある店' },
      { role: 'assistant', text: '候補を3つ出しました。' },
    ]);
    for (const internal of [
      'observation-secret',
      'fetchedAt',
      'fixture-provider',
      'example.com/shop',
      'turn-4',
      'thread-1',
    ]) {
      expect(serialized).not.toContain(internal);
    }
  });
});
