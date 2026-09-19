import * as v from 'valibot';
import type { DetailField } from '@worker/domain/primitives';

/** A decision is scoped to one model-context use; unknown never grants access. */
export const ModelContextFieldDecisionSchema = v.picklist(['allow', 'deny', 'unknown']);
export type ModelContextFieldDecision = v.InferOutput<typeof ModelContextFieldDecisionSchema>;

const ModelEvidenceFieldPolicySchema = v.strictObject({
  identity: ModelContextFieldDecisionSchema,
  opening_hours: ModelContextFieldDecisionSchema,
  price: ModelContextFieldDecisionSchema,
  photos: ModelContextFieldDecisionSchema,
  contact: ModelContextFieldDecisionSchema,
  facilities: ModelContextFieldDecisionSchema,
  walking_route: ModelContextFieldDecisionSchema,
  last_train: ModelContextFieldDecisionSchema,
});

export const ModelContextFieldPolicySchema = v.strictObject({
  evidence: ModelEvidenceFieldPolicySchema,
  history: ModelContextFieldDecisionSchema,
  cardSet: ModelContextFieldDecisionSchema,
  displayName: ModelContextFieldDecisionSchema,
});
export type ModelContextFieldPolicy = v.InferOutput<typeof ModelContextFieldPolicySchema>;

/** `unknown` is intentionally treated as deny at the model boundary. */
export const modelContextFieldAllowed = (decision: ModelContextFieldDecision): boolean =>
  decision === 'allow';

const DENY: ModelContextFieldDecision = 'deny';

/** Production-safe default. A Worker must replace this only with an evaluated policy snapshot. */
export const denyModelContextFieldPolicy: ModelContextFieldPolicy = {
  evidence: {
    identity: DENY,
    opening_hours: DENY,
    price: DENY,
    photos: DENY,
    contact: DENY,
    facilities: DENY,
    walking_route: DENY,
    last_train: DENY,
  },
  history: DENY,
  cardSet: DENY,
  displayName: DENY,
};

export const modelEvidenceFieldDecision = (
  policy: ModelContextFieldPolicy,
  field: DetailField,
): ModelContextFieldDecision => policy.evidence[field];
