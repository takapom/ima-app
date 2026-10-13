import * as v from 'valibot';
import { EvalRunResultSchema, type EvalTurnRecord } from '../eval-contract';
import { searchAreaOf } from './tool-args';

/**
 * promptfooの`javascript`アサーションから`file://assertions.ts:関数名`で呼ぶ判定。
 * どれもProviderのmetadataにある記録だけを見て、決定的に合否を返す。
 * 判定は最後のターンを対象にする。
 */
type AssertionContext = {
  readonly metadata?: Record<string, unknown>;
  readonly providerResponse?: { readonly metadata?: Record<string, unknown> };
  readonly config?: Record<string, unknown>;
};
type GradingResult = { readonly pass: boolean; readonly score: number; readonly reason: string };

const result = (pass: boolean, reason: string): GradingResult => ({
  pass,
  score: pass ? 1 : 0,
  reason,
});

const lastTurnOf = (context: AssertionContext): EvalTurnRecord | undefined => {
  const raw = context.metadata?.evalRun ?? context.providerResponse?.metadata?.evalRun;
  const parsed = v.safeParse(EvalRunResultSchema, raw);
  return parsed.success ? parsed.output.turns.at(-1) : undefined;
};

const judge = (
  context: AssertionContext,
  check: (turn: EvalTurnRecord) => GradingResult,
): GradingResult => {
  const turn = lastTurnOf(context);
  return turn === undefined ? result(false, '評価の記録がありません') : check(turn);
};

/**
 * 「何かをしなかったこと」を確かめる判定は、ターンが確定していなければ判定できない。
 * 失敗して何もしなかったターンを合格に数えて指標を水増ししないよう、不合格にする。
 */
const judgeCommitted = (
  context: AssertionContext,
  check: (turn: EvalTurnRecord) => GradingResult,
): GradingResult =>
  judge(context, (turn) =>
    turn.committed
      ? check(turn)
      : result(false, `確定していないため判定できない（${turn.failureCode ?? turn.runStatus}）`),
  );

const searchAreas = (turn: EvalTurnRecord): string[] =>
  turn.toolCalls
    .filter((call) => call.name === 'search_places')
    .map((call) => searchAreaOf(call.args).kind);

export const committed = (_output: string, context: AssertionContext): GradingResult =>
  judge(context, (turn) =>
    result(
      turn.committed,
      turn.committed
        ? 'ターンが確定した'
        : `確定しなかった（${turn.failureCode ?? turn.runStatus}）`,
    ),
  );

/** アサーションの`config.kind`と、確定した応答の種別を比べる。 */
export const kindIs = (_output: string, context: AssertionContext): GradingResult => {
  const expected = context.config?.kind;
  if (expected !== 'ask' && expected !== 'answer' && expected !== 'propose') {
    return result(false, 'config.kindにask・answer・proposeのいずれかを指定してください');
  }
  return judge(context, (turn) =>
    result(turn.kind === expected, `期待 ${expected}・実際 ${turn.kind ?? '確定なし'}`),
  );
};

export const firstSearchUsesCurrentLocation = (
  _output: string,
  context: AssertionContext,
): GradingResult =>
  judge(context, (turn) => {
    const first = searchAreas(turn)[0];
    return result(first === 'current_location', `最初の検索の場所: ${first ?? '検索なし'}`);
  });

export const neverSearchesCurrentLocation = (
  _output: string,
  context: AssertionContext,
): GradingResult =>
  judgeCommitted(context, (turn) => {
    const areas = searchAreas(turn);
    return result(
      !areas.includes('current_location'),
      `検索の場所: ${areas.join(', ') || '検索なし'}`,
    );
  });

export const searchesNamedArea = (_output: string, context: AssertionContext): GradingResult =>
  judge(context, (turn) => {
    const areas = searchAreas(turn);
    return result(areas.includes('named_area'), `検索の場所: ${areas.join(', ') || '検索なし'}`);
  });

export const noCards = (_output: string, context: AssertionContext): GradingResult =>
  judgeCommitted(context, (turn) =>
    result(
      turn.cards.length === 0 && turn.kind !== 'propose',
      `カード ${turn.cards.length}件・種別 ${turn.kind ?? '確定なし'}`,
    ),
  );
