import * as v from 'valibot';
import {
  EvalCaseSchema,
  EvalToolDescriptionsSchema,
  type EvalCase,
  type EvalToolDescriptions,
  type EvalRunResult,
  type EvalToolCall,
  type EvalTurnRecord,
} from '../eval-contract';
import { searchAreaOf, searchQueryOf } from './tool-args';

/** promptfooの`prompts`にこの値を書くと、本番のシステムプロンプトをそのまま使う。 */
export const PRODUCTION_PROMPT = 'production';

const textVar = (vars: Record<string, unknown>, name: string): string | undefined => {
  const value = vars[name];
  return typeof value === 'string' ? value : undefined;
};

/**
 * promptfooのvarsとプロンプトから評価ケースを作る。
 * `turns`は1行1発話の文字列にする（配列のvarsはpromptfooが別ケースに展開してしまうため）。
 */
type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const invalidFields = (issues: readonly v.BaseIssue<unknown>[]): string =>
  [...new Set(issues.map((issue) => v.getDotPath(issue) ?? '(root)'))].join(', ');

/** Toolのdescriptionの案（JSON）を検証する。書けるのは公開Toolの名前だけ。 */
export const parseToolDescriptions = (raw: unknown): Parsed<EvalToolDescriptions> => {
  const parsed = v.safeParse(EvalToolDescriptionsSchema, raw);
  return parsed.success
    ? { ok: true, value: parsed.output }
    : { ok: false, error: `Toolのdescriptionの案が不正です: ${invalidFields(parsed.issues)}` };
};

export const evalCaseFrom = (
  prompt: string,
  vars: Record<string, unknown>,
  toolDescriptions?: EvalToolDescriptions,
): Parsed<EvalCase> => {
  const turns = (textVar(vars, 'turns') ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const systemPrompt = prompt.trim() === PRODUCTION_PROMPT ? undefined : prompt;
  const parsed = v.safeParse(EvalCaseSchema, {
    shopSet: vars.shopSet,
    now: vars.now,
    location: vars.location,
    turns,
    areaText: vars.areaText ?? null,
    budget: vars.budget ?? null,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(toolDescriptions === undefined ? {} : { toolDescriptions }),
  });
  if (parsed.success) return { ok: true, value: parsed.output };
  return { ok: false, error: `評価ケースのvarsが不正です: ${invalidFields(parsed.issues)}` };
};

const toolLabel = (call: EvalToolCall): string => {
  const area = searchAreaOf(call.args);
  const where =
    area.kind === 'current_location'
      ? `現在地 ${area.radiusMeters ?? '?'}m`
      : area.kind === 'named_area'
        ? `地名「${area.name ?? '?'}」`
        : undefined;
  const query = searchQueryOf(call.args);
  const result = call.result;
  const outcome =
    result === null
      ? '結果なし'
      : [
          result.status,
          result.code,
          result.candidates === null ? null : `${result.candidates}件`,
          ...result.issues,
        ]
          .filter((part): part is string => typeof part === 'string')
          .join(' ');
  return `${call.name}${query === null ? '' : `「${query}」`}${where === undefined ? '' : `（${where}）`} → ${outcome}`;
};

const turnText = (turn: EvalTurnRecord, index: number): string => {
  const lines = [
    `[ターン${index + 1}] ${turn.userText}`,
    `結果: ${turn.committed ? `${turn.kind ?? '種別不明'}で確定` : `確定なし（${turn.runStatus}${turn.failureCode === null ? '' : ` ${turn.failureCode}`}）`}`,
    ...turn.messages.map((message) => `メッセージ: ${message}`),
    ...turn.cards.map(
      (card, cardIndex) =>
        `カード${cardIndex + 1}: ${card.name ?? '店名なし'} — ${card.why}${card.diff === null ? '' : `（${card.diff}）`}`,
    ),
    ...turn.toolCalls.map((call) => `Tool: ${toolLabel(call)}`),
    ...(turn.toolResultsMatched ? [] : ['Tool結果: 呼び出しと対応付けられないため表示しない']),
    `step: ${turn.modelCalls.length}（Toolなし ${turn.respondMissing.length}・確定拒否 ${turn.respondRejections.length}・打ち切り ${turn.modelCalls.filter((call) => call.failure === 'aborted').length}）`,
  ];
  return lines.join('\n');
};

/** 人が読み、LLM採点にも渡せる形の出力。構造化した記録はmetadataに入れる。 */
export const renderEvalRun = (run: EvalRunResult): string =>
  run.turns.map((turn, index) => turnText(turn, index)).join('\n\n');

export const tokenUsageOf = (run: EvalRunResult) => {
  let prompt = 0;
  let completion = 0;
  for (const call of run.turns.flatMap((turn) => turn.modelCalls)) {
    prompt += call.inputTokens ?? 0;
    completion += call.outputTokens ?? 0;
  }
  return { total: prompt + completion, prompt, completion };
};

/**
 * 評価の仕組み側の理由でターンを評価できなかったときに、その理由を返す。
 * 実行環境の設定で実行されなかった場合、案を適用できなかった場合、
 * モデル呼び出し自体の失敗（キー・通信・Providerの障害）が該当する。
 * これらをモデルの振る舞いの失敗（FAIL）と分け、promptfooではERRORとして表示する。
 * 実行側による打ち切り（時間切れなど）は、利用者にも起きる失敗なのでここには含めない。
 */
export const evaluationErrorOf = (run: EvalRunResult): string | undefined => {
  for (const [index, turn] of run.turns.entries()) {
    if (turn.failureCode === 'RUNTIME_UNCONFIGURED') {
      return `ターン${index + 1}を実行できませんでした（RUNTIME_UNCONFIGURED）。envファイルのIMA_*設定とAPIキーを確認してください。`;
    }
    if (turn.evalError === 'SYSTEM_PROMPT_NOT_FOUND') {
      return `ターン${index + 1}でシステムプロンプト案を適用できませんでした（モデル入力に本番のプロンプトが見つからない）。`;
    }
    if (turn.evalError === 'TOOL_DESCRIPTION_TARGET_NOT_FOUND') {
      return `ターン${index + 1}でToolのdescriptionの案を適用できませんでした（案に書いたToolがモデル入力にない）。`;
    }
    if (
      turn.modelCalls.some(
        (call) => call.failure === 'call_failed' || call.failure === 'stream_failed',
      )
    ) {
      return `ターン${index + 1}でモデル呼び出しが失敗したため評価できません。APIキーと通信を確認してください。`;
    }
  }
  return undefined;
};
