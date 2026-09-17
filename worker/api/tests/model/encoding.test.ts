import { describe, expect, it } from 'vitest';
import { createModelContext } from './fixtures';
import { encodeModelContext } from '@api/model/encoding';
import { MODEL_SYSTEM_PROMPT, MODEL_TERMINAL_MODES } from '@api/model/system-prompt';

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

  it('keeps the provider terminal modes explicit', () => {
    expect(MODEL_TERMINAL_MODES).toEqual(['final_message', 'submit_cards']);
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
