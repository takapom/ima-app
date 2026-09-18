import { describe, expect, it } from 'vitest';
import { createModelContext } from './fixtures';
import { encodeModelContext } from '@worker/infrastructure/runtime/model/encoding';
import { MODEL_SYSTEM_PROMPT } from '@worker/infrastructure/runtime/model/system-prompt';

describe('model message encoding', () => {
  it('keeps the original mixed-intent request and only sends projected context', () => {
    const context = createModelContext();
    const messages = encodeModelContext(context);

    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(MODEL_SYSTEM_PROMPT);
    expect(messages[0]?.content).toContain('facts');
    expect(messages[0]?.content).toContain('inference');
    expect(messages[0]?.content).toContain('unknown');
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
    expect(MODEL_SYSTEM_PROMPT).toContain('why.textが80字');
    expect(MODEL_SYSTEM_PROMPT).toContain('diff.textが40字');
    expect(MODEL_SYSTEM_PROMPT).toContain('submit_cardsのmessageは各textが300字で最大4件');
    expect(MODEL_SYSTEM_PROMPT).toContain(
      'final_messageのmessageは配列ではなく1件のオブジェクトで、textは300字以内',
    );
  });

  it('keeps terminal formatting and unsupported constraint safeguards', () => {
    expect(MODEL_SYSTEM_PROMPT).toContain(
      'Toolを呼ぶstepには文章を書かないでください。「探します」のような前置きは破棄され、終端としては扱いません。終端を返すstepではToolを呼ばず、final_messageのenvelopeかsubmit_cardsのどちらかだけを出してください。空の応答で終わらないでください。',
    );
    expect(MODEL_SYSTEM_PROMPT).toContain('徒歩経路と終電は現在の接続では取得できません');
    expect(MODEL_SYSTEM_PROMPT).toContain('ユーザーがminimumStayMinutesを明示的に変更した場合だけ');
    expect(MODEL_SYSTEM_PROMPT).toContain(
      'maxWalkMinutes・homeStationRefをturnConstraintsへ提案しない',
    );
  });

  it('leaves provider search and card preparation instructions in tool descriptions', () => {
    expect(MODEL_SYSTEM_PROMPT).not.toContain('空白区切りのAND検索');
    expect(MODEL_SYSTEM_PROMPT).not.toContain('1st step');
    expect(MODEL_SYSTEM_PROMPT).toContain('各Toolのdescriptionに従ってください');
  });

  it('describes the final message JSON envelope and evidence basis enum', () => {
    const [system] = encodeModelContext(createModelContext());
    expect(system?.content).toContain(
      '{"kind":"final_message","message":{"text":"確認しました","evidenceIds":[],"basis":"conversational"},"metadata":{}}',
    );
    expect(system?.content).toContain('grounded、inference、conversational');
    expect(system?.content).toContain('sourceTurnId');
  });
});
