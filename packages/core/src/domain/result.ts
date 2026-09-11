import * as v from 'valibot';
import { ObservationSchema } from './evidence';
import { IssueSchema } from './issue';
import { Text } from './primitives';

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

export const AnyFieldResultSchema = FieldResultSchema(v.unknown());

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
