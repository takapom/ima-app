import { configStrings, judge, result, searchCalls, type Assertion } from './assertion-support';

/**
 * スコア。改善の度合いを測る指標で、評価ケースでは`weight: 0`を付けて使う。
 * promptfooはweight 0のアサーションを指標として記録するが、ケースの合否には使わない。
 * 退行を許さない規則は必須ゲート（assertions.ts）に置く。
 */

/** 現在地周辺の検索は、半径1000mから始める。 */
export const firstRadiusIs1000: Assertion = (_output, context) =>
  judge(context, (turn) => {
    const first = searchCalls(turn).find((call) => call.area.kind === 'current_location');
    if (first === undefined) return result(false, '現在地周辺の検索なし');
    const radius = first.area.kind === 'current_location' ? first.area.radiusMeters : null;
    return result(radius === 1000, `最初の半径: ${radius ?? '不明'}m`);
  });

/** 検索語に`config.words`（気分や要望の表現）をそのまま入れず、ジャンル語へ置き換えている。 */
export const queryAvoidsWords: Assertion = (_output, context) => {
  const words = configStrings(context, 'words');
  if (words === undefined || words.length === 0) {
    return result(false, 'config.wordsに避ける語の配列を指定してください');
  }
  return judge(context, (turn) => {
    const queries = searchCalls(turn).flatMap((call) => (call.query === null ? [] : [call.query]));
    if (queries.length === 0) return result(false, '検索なし');
    const used = words.filter((word) => queries.some((query) => query.includes(word)));
    return result(
      used.length === 0,
      used.length === 0
        ? `検索語: ${queries.join(' / ')}`
        : `要望の語をそのまま検索: ${used.join('・')}`,
    );
  });
};

/** Tool引数の拒否・確定の拒否がなく、修復を使わずに確定した。 */
export const noRepairs: Assertion = (_output, context) =>
  judge(context, (turn) => {
    const rejectedInputs = turn.toolCalls.filter((call) => call.result?.status === 'tool_error');
    const repairs = rejectedInputs.length + turn.respondRejections.length;
    return result(
      turn.committed && repairs === 0,
      `引数の拒否 ${rejectedInputs.length}回・確定の拒否 ${turn.respondRejections.length}回`,
    );
  });
