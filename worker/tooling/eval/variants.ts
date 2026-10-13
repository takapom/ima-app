import { MODEL_SYSTEM_PROMPT } from '@worker/infrastructure/runtime/model/system-prompt';
import type { RuntimeModelGuardCallOptions } from '@worker/infrastructure/runtime/turn-execution/runtime-model-guard';
import type { EvalCase, EvalToolDescriptions, EvalTurnRecord } from './eval-contract';

type Prompt = RuntimeModelGuardCallOptions['prompt'];
type Tools = NonNullable<RuntimeModelGuardCallOptions['tools']>;
type VariantFailure = NonNullable<EvalTurnRecord['evalError']>;

/** 評価する案。どちらも省略時は本番のものを使う。 */
export type EvalVariant = Pick<EvalCase, 'systemPrompt' | 'toolDescriptions'>;

/** 案を適用できないときに投げる。本番と違う入力を、案として黙って評価しないため。 */
export class EvalVariantNotAppliedError extends Error {
  readonly reason: VariantFailure;

  constructor(reason: VariantFailure) {
    super(`the evaluation variant could not be applied: ${reason}`);
    this.name = 'EvalVariantNotAppliedError';
    this.reason = reason;
  }
}

/** 本番のシステムプロンプトと一致するsystemメッセージを案に置き換える。 */
export const applySystemPrompt = (prompt: Prompt, replacement: string): Prompt => {
  let replaced = 0;
  const next = prompt.map((message) => {
    if (message.role !== 'system' || message.content !== MODEL_SYSTEM_PROMPT) return message;
    replaced += 1;
    return { ...message, content: replacement };
  });
  if (replaced === 0) throw new EvalVariantNotAppliedError('SYSTEM_PROMPT_NOT_FOUND');
  return next;
};

/**
 * 案に書いたToolのdescriptionだけを置き換える。
 * 通常のstepでは公開Toolがすべて渡るため、案の対象が見つからなければ失敗させる。
 * 最終stepはrespondだけが渡るため、Toolが1つのときは欠けを問わない。
 */
export const applyToolDescriptions = (tools: Tools, replacements: EvalToolDescriptions): Tools => {
  const offered = new Set(tools.map((tool) => tool.name));
  const targets = Object.entries(replacements).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (tools.length > 1 && targets.some(([name]) => !offered.has(name))) {
    throw new EvalVariantNotAppliedError('TOOL_DESCRIPTION_TARGET_NOT_FOUND');
  }
  const byName = new Map(targets);
  return tools.map((tool) => {
    const description = byName.get(tool.name);
    return tool.type === 'function' && description !== undefined ? { ...tool, description } : tool;
  });
};

/** モデルに渡す直前の入力に案を適用する。案が置き換えない部分は本番のまま渡す。 */
export const applyVariant = (
  params: RuntimeModelGuardCallOptions,
  variant: EvalVariant,
): RuntimeModelGuardCallOptions => {
  let next = params;
  if (variant.systemPrompt !== undefined) {
    next = { ...next, prompt: applySystemPrompt(next.prompt, variant.systemPrompt) };
  }
  if (variant.toolDescriptions !== undefined && next.tools !== undefined) {
    next = { ...next, tools: applyToolDescriptions(next.tools, variant.toolDescriptions) };
  }
  return next;
};
