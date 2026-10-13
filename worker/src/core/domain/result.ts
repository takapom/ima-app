import * as v from 'valibot';
import { ObservationSchema } from '@worker/core/domain/evidence/evidence';
import { IssueSchema } from '@worker/core/domain/issue';
import { Text } from '@worker/core/domain/primitives';

/**
 * 1項目の取得結果。known は観測が付いているときだけ使い、unknown、unsupported、not_applicable、error は別状態のまま残す。
 * 値が無い項目を推測で known にしない。同じ observationId を複数の根拠として数えない。
 */
export const FieldResultSchema = <T extends v.GenericSchema>(value: T) =>
  v.variant('status', [
    v.pipe(
      v.strictObject({
        status: v.literal('known'),
        observations: v.pipe(v.array(ObservationSchema(value)), v.minLength(1), v.maxLength(8)),
      }),
      v.check(
        (result) =>
          new Set(result.observations.map((observation) => observation.observationId)).size ===
          result.observations.length,
        'observation IDs must be unique within a field result',
      ),
    ),
    v.strictObject({
      status: v.picklist(['unknown', 'unsupported', 'not_applicable']),
      reason: Text(300),
    }),
    v.strictObject({
      status: v.literal('error'),
      error: IssueSchema,
    }),
  ]);

type FieldResultOutput<T> = v.InferOutput<
  ReturnType<typeof FieldResultSchema<v.GenericSchema<unknown, T>>>
>;
export type FieldResult<T> = FieldResultOutput<T>;

/** 項目の value 型がまだ決まっていないとき用の FieldResult スキーマ。 */
export const AnyFieldResultSchema = FieldResultSchema(v.unknown());

/**
 * 一連の処理の成否。ok と partial は data を伴い、error は Issue だけで data を持たない。
 * partial は一部の失敗を全体の成功に見せない状態であり、warnings を消して ok と同じ結果にしない。
 */
export const ResultSchema = <T extends v.GenericSchema>(data: T) =>
  v.union([
    v.strictObject({
      status: v.picklist(['ok', 'partial']),
      data,
      warnings: v.array(IssueSchema),
    }),
    v.strictObject({
      status: v.literal('error'),
      error: IssueSchema,
    }),
  ]);

type ResultOutput<T> = v.InferOutput<ReturnType<typeof ResultSchema<v.GenericSchema<unknown, T>>>>;
export type Result<T> = ResultOutput<T>;
