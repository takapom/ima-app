import * as v from 'valibot';

/**
 * promptfooのProvider（Node）と評価用Worker（workerd）の間のHTTP契約。
 * promptfooがWorkerのパスaliasなしで読み込めるよう、valibot以外をimportしない。
 */

export const EVAL_LOCATION_STATUSES = [
  'available',
  'denied',
  'reduced',
  'timeout',
  'unavailable',
] as const;

const userText = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500));

/**
 * `2026-10-10T11:00:00.000Z`の形だけを受け付ける。`v.isoTimestamp()`は2月30日のような
 * 存在しない日付も通すため、Dateに変換して同じ文字列に戻ることまで確かめる。
 */
const canonicalUtcTimestamp = v.pipe(
  v.string(),
  v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  v.check((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }, 'now must be an existing UTC time'),
);

export const EvalCaseSchema = v.strictObject({
  /** 合成店舗セットの名前。座標はセットと一緒にWorkerの中だけに置く。 */
  shopSet: v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,64}$/u)),
  /**
   * 全ターンのサーバー時刻で、スレッドの作成時刻とセッション期限の起点にもなる。
   * 掲載営業時間の読み方を実行ごとに揃えるため固定する。
   */
  now: canonicalUtcTimestamp,
  location: v.picklist(EVAL_LOCATION_STATUSES),
  /** 1ターン1発話。同じスレッドで順に実行する。 */
  turns: v.pipe(v.array(userText), v.minLength(1), v.maxLength(4)),
  areaText: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(160))), null),
  budget: v.optional(v.nullable(v.picklist(['cheap', 'normal', 'any'])), null),
  /** 本番のシステムプロンプトを置き換える案。省略時は本番の定数を使う。 */
  systemPrompt: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(20_000))),
});
export type EvalCase = v.InferOutput<typeof EvalCaseSchema>;
export type EvalCaseInput = v.InferInput<typeof EvalCaseSchema>;

const nullableCount = v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0)));

export const EvalToolResultSchema = v.strictObject({
  /** モデルが見た結果の状態（`ok`・`error`・`invalid`・`committed`・`tool_error`など）。 */
  status: v.string(),
  code: v.nullable(v.string()),
  candidates: nullableCount,
  issues: v.array(v.string()),
});
export type EvalToolResult = v.InferOutput<typeof EvalToolResultSchema>;

export const EvalToolCallSchema = v.strictObject({
  name: v.string(),
  /** モデルが生成したままの引数。JSONとして読めなければnull。 */
  args: v.unknown(),
  /** 後続のstepで結果がモデルに渡らなかった場合はnull。 */
  result: v.nullable(EvalToolResultSchema),
});
export type EvalToolCall = v.InferOutput<typeof EvalToolCallSchema>;

export const EvalModelCallSchema = v.strictObject({
  ms: v.pipe(v.number(), v.minValue(0)),
  inputTokens: nullableCount,
  outputTokens: nullableCount,
  toolNames: v.array(v.string()),
  /**
   * 呼び出しが正常に終わらなかった理由。`call_failed`と`stream_failed`はキー・通信・Providerの
   * 失敗で、評価できない実行として扱う。`aborted`は実行側が打ち切った（時間切れなど）もので、
   * モデルの振る舞いの結果として採点する。
   */
  failure: v.nullable(v.picklist(['call_failed', 'stream_failed', 'aborted'])),
});
export type EvalModelCall = v.InferOutput<typeof EvalModelCallSchema>;

export const EvalCardSchema = v.strictObject({
  name: v.nullable(v.string()),
  why: v.string(),
  diff: v.nullable(v.string()),
});

export const EvalTurnRecordSchema = v.strictObject({
  userText: v.string(),
  runStatus: v.picklist(['completed', 'cancelled', 'failed', 'stale']),
  failureCode: v.nullable(v.string()),
  committed: v.boolean(),
  kind: v.nullable(v.picklist(['ask', 'answer', 'propose'])),
  messages: v.array(v.string()),
  cards: v.array(EvalCardSchema),
  searchOutcome: v.nullable(v.literal('no_candidates')),
  toolCalls: v.array(EvalToolCallSchema),
  /**
   * Toolの結果を呼び出しと対応付けられたか。promptの呼び出し列が記録と食い違うときはfalseにし、
   * 誤った結果を付けずに全件の結果をnullにする。
   */
  toolResultsMatched: v.boolean(),
  modelCalls: v.array(EvalModelCallSchema),
  /** Toolを呼ばずに終わったstepごとに1件。そのstepでは何も確定しない。 */
  respondMissing: v.array(v.picklist(['TEXT_WITHOUT_RESPOND', 'EMPTY_STEP'])),
  respondRejections: v.array(
    v.strictObject({
      codes: v.array(v.string()),
      remainingRepairs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    }),
  ),
  /** 評価の仕組み側でターンを正しく実行できなかった理由。モデルの採点には使わない。 */
  evalError: v.nullable(v.picklist(['SYSTEM_PROMPT_NOT_FOUND'])),
});
export type EvalTurnRecord = v.InferOutput<typeof EvalTurnRecordSchema>;

export const EvalRunResultSchema = v.strictObject({
  turns: v.pipe(v.array(EvalTurnRecordSchema), v.minLength(1)),
});
export type EvalRunResult = v.InferOutput<typeof EvalRunResultSchema>;

export const EvalFailureSchema = v.strictObject({
  error: v.picklist([
    'INVALID_CASE',
    'UNKNOWN_SHOP_SET',
    'OPENAI_API_KEY_MISSING',
    'NOT_FOUND',
    'TURN_FAILED',
  ]),
});
export type EvalFailure = v.InferOutput<typeof EvalFailureSchema>;

export const EvalHealthSchema = v.strictObject({
  ready: v.literal(true),
  modelKeyConfigured: v.boolean(),
  /** 起動時にProviderが渡した識別子。別のプロセスが同じポートで答えていないかを確かめる。 */
  instance: v.nullable(v.string()),
});
export type EvalHealth = v.InferOutput<typeof EvalHealthSchema>;
