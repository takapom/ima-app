import { describe, expect, it } from 'vitest';
import { MODEL_SYSTEM_PROMPT } from '@worker/runtime/model/system-prompt';
import type { RuntimeModelGuardCallOptions } from '@worker/runtime/turn-execution/runtime-model-guard';
import {
  applySystemPrompt,
  applyToolDescriptions,
  applyVariant,
  EvalVariantNotAppliedError,
} from '../../tooling/eval/variants';

type Tools = NonNullable<RuntimeModelGuardCallOptions['tools']>;

const tool = (name: string): Tools[number] => ({
  type: 'function',
  name,
  description: `${name}の本番のdescription`,
  inputSchema: { type: 'object' },
});

const allTools: Tools = [tool('search_places'), tool('get_place_details'), tool('respond')];

const prompt: RuntimeModelGuardCallOptions['prompt'] = [
  // Thinkが先頭に足す既定のsystemは置き換えない。
  { role: 'system', content: 'Thinkの既定の指示' },
  { role: 'system', content: MODEL_SYSTEM_PROMPT },
  { role: 'user', content: [{ type: 'text', text: '文脈' }] },
];

const reasonOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error: unknown) {
    return error instanceof EvalVariantNotAppliedError ? error.reason : 'unexpected';
  }
};

describe('applySystemPrompt', () => {
  it('replaces only the production system prompt', () => {
    expect(applySystemPrompt(prompt, '案')).toEqual([
      { role: 'system', content: 'Thinkの既定の指示' },
      { role: 'system', content: '案' },
      prompt[2],
    ]);
  });

  it('refuses when the production prompt is missing', () => {
    const withoutProduction = prompt.filter((message) => message.content !== MODEL_SYSTEM_PROMPT);
    expect(reasonOf(() => applySystemPrompt(withoutProduction, '案'))).toBe(
      'SYSTEM_PROMPT_NOT_FOUND',
    );
  });
});

describe('applyToolDescriptions', () => {
  it('replaces only the tools the variant names', () => {
    const next = applyToolDescriptions(allTools, { search_places: '検索の案' });
    expect(next.map((entry) => (entry.type === 'function' ? entry.description : null))).toEqual([
      '検索の案',
      'get_place_detailsの本番のdescription',
      'respondの本番のdescription',
    ]);
    // 元のTool定義は書き換えない。
    expect(allTools[0]).toEqual(tool('search_places'));
  });

  it('refuses a variant whose tool is missing from a normal step', () => {
    expect(
      reasonOf(() =>
        applyToolDescriptions([tool('search_places'), tool('respond')], {
          get_place_details: '案',
        }),
      ),
    ).toBe('TOOL_DESCRIPTION_TARGET_NOT_FOUND');
  });

  it('accepts the final step, which offers only respond', () => {
    const next = applyToolDescriptions([tool('respond')], {
      search_places: '検索の案',
      respond: '確定の案',
    });
    expect(next.map((entry) => (entry.type === 'function' ? entry.description : null))).toEqual([
      '確定の案',
    ]);
  });
});

describe('applyVariant', () => {
  it('leaves the input unchanged without a variant', () => {
    const params: RuntimeModelGuardCallOptions = { prompt, tools: allTools };
    expect(applyVariant(params, {})).toBe(params);
  });

  it('applies the prompt and the tool descriptions together', () => {
    const next = applyVariant(
      { prompt, tools: allTools },
      { systemPrompt: '案', toolDescriptions: { respond: '確定の案' } },
    );
    expect(next.prompt[1]).toEqual({ role: 'system', content: '案' });
    expect(next.tools?.[2]).toMatchObject({ name: 'respond', description: '確定の案' });
  });

  it('does not add tools to a call that has none', () => {
    const next = applyVariant({ prompt }, { toolDescriptions: { respond: '確定の案' } });
    expect('tools' in next).toBe(false);
  });
});
