import * as v from 'valibot';
import { TurnIdSchema, OpaqueIdSchema, SafeIntegerSchema, Text } from '@core/domain/primitives';

const PositiveMinutesSchema = v.pipe(SafeIntegerSchema, v.minValue(1), v.maxValue(180));

export const TurnConstraintChangeSchema = v.pipe(
  v.strictObject({
    maxWalkMinutes: v.optional(PositiveMinutesSchema),
    homeStationRef: v.optional(OpaqueIdSchema),
    minimumStayMinutes: v.optional(PositiveMinutesSchema),
    sourceTurnId: TurnIdSchema,
    quote: Text(300),
  }),
  v.check(
    (change) =>
      change.maxWalkMinutes !== undefined ||
      change.homeStationRef !== undefined ||
      change.minimumStayMinutes !== undefined,
    'turn constraint change must set at least one constraint',
  ),
);
export type TurnConstraintChange = v.InferOutput<typeof TurnConstraintChangeSchema>;

export const TurnConstraintsSchema = v.pipe(
  v.strictObject({
    changes: v.pipe(v.array(TurnConstraintChangeSchema), v.minLength(1), v.maxLength(3)),
  }),
  v.check(
    (constraints) =>
      new Set(constraints.changes.map((change) => change.sourceTurnId)).size ===
      constraints.changes.length,
    'turn constraint source turns must be unique',
  ),
);
export type TurnConstraints = v.InferOutput<typeof TurnConstraintsSchema>;

/** Metadata attached to a model action; it is not a fourth tool or a preference mutation. */
export const ModelActionMetadataSchema = v.strictObject({
  turnConstraints: v.optional(TurnConstraintsSchema),
});
export type ModelActionMetadata = v.InferOutput<typeof ModelActionMetadataSchema>;
