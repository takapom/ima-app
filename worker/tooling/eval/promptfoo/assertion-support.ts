import * as v from 'valibot';
import { EvalRunResultSchema, type EvalTurnRecord } from '../eval-contract';
import { searchAreaOf, searchQueryOf } from './tool-args';

/**
 * promptfooの`javascript`アサーションに共通する部品。
 * 判定はProviderのmetadataにある記録だけを見て、決定的に合否を返す。
 */
export type AssertionContext = {
  readonly metadata?: Record<string, unknown>;
  readonly providerResponse?: { readonly metadata?: Record<string, unknown> };
  readonly config?: Record<string, unknown>;
};
export type GradingResult = {
  readonly pass: boolean;
  readonly score: number;
  readonly reason: string;
};
export type Assertion = (output: string, context: AssertionContext) => GradingResult;

export const result = (pass: boolean, reason: string): GradingResult => ({
  pass,
  score: pass ? 1 : 0,
  reason,
});

const turnsOf = (context: AssertionContext): readonly EvalTurnRecord[] | undefined => {
  const raw = context.metadata?.evalRun ?? context.providerResponse?.metadata?.evalRun;
  const parsed = v.safeParse(EvalRunResultSchema, raw);
  return parsed.success ? parsed.output.turns : undefined;
};

/** 最後のターンで判定する。記録がなければ不合格。前のターンも渡す（複数ターンのケース用）。 */
export const judge = (
  context: AssertionContext,
  check: (turn: EvalTurnRecord, previous: EvalTurnRecord | undefined) => GradingResult,
): GradingResult => {
  const turns = turnsOf(context);
  const turn = turns?.at(-1);
  return turn === undefined ? result(false, '評価の記録がありません') : check(turn, turns?.at(-2));
};

/**
 * 確定したターンだけを判定する。「何かをしなかったこと」は、失敗して何もしなかったターンでも
 * 成り立ってしまうため、確定していなければ不合格にして指標を水増ししない。
 */
export const judgeCommitted = (
  context: AssertionContext,
  check: (turn: EvalTurnRecord, previous: EvalTurnRecord | undefined) => GradingResult,
): GradingResult =>
  judge(context, (turn, previous) =>
    turn.committed
      ? check(turn, previous)
      : result(false, `確定していないため判定できない（${turn.failureCode ?? turn.runStatus}）`),
  );

/** アサーションの`config`から文字列の配列を読む。書かれていなければundefined。 */
export const configStrings = (context: AssertionContext, key: string): string[] | undefined => {
  const value = context.config?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
};

export const configString = (context: AssertionContext, key: string): string | undefined => {
  const value = context.config?.[key];
  return typeof value === 'string' ? value : undefined;
};

export const searchCalls = (turn: EvalTurnRecord) =>
  turn.toolCalls
    .filter((call) => call.name === 'search_places')
    .map((call) => ({ area: searchAreaOf(call.args), query: searchQueryOf(call.args) }));

export const cardNames = (turn: EvalTurnRecord | undefined): string[] =>
  (turn?.cards ?? []).flatMap((card) => (card.name === null ? [] : [card.name]));

/** ユーザーに見える文（メッセージ・選定理由・比較）。 */
export const visibleTexts = (turn: EvalTurnRecord): string[] => [
  ...turn.messages,
  ...turn.cards.flatMap((card) => [card.why, ...(card.diff === null ? [] : [card.diff])]),
];
