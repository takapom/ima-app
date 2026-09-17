import * as v from 'valibot';
import { HttpsUrlSchema, IsoTimestampSchema, Text } from '@core/domain/primitives';

export const AttributionSchema = v.strictObject({
  label: Text(160),
  sourceLink: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});
export type Attribution = v.InferOutput<typeof AttributionSchema>;

export const RetentionDecisionSchema = v.picklist(['allow', 'deny', 'unknown']);
export type RetentionDecision = v.InferOutput<typeof RetentionDecisionSchema>;

export const RetentionModeSchema = v.picklist([
  'provider_limited',
  'identifier_indefinite_owner_scoped',
  'session_only',
  'none',
]);
export type RetentionMode = v.InferOutput<typeof RetentionModeSchema>;

export const RestoreModeSchema = v.picklist(['full', 'reference_only', 'unavailable']);
export type RestoreMode = v.InferOutput<typeof RestoreModeSchema>;

export const PolicyStatusSchema = v.picklist([
  'available',
  'policy_withheld',
  'disabled_m35',
  'disabled_capability',
  'attribution_missing',
  'expired',
]);
export type PolicyStatus = v.InferOutput<typeof PolicyStatusSchema>;
export const DisplayPolicyStatusSchema = PolicyStatusSchema;

const atOrBefore = (left: string | null, right: string | null) =>
  left === null || right === null || Date.parse(left) <= Date.parse(right);

export const RetentionMetadataSchema = v.pipe(
  v.strictObject({
    retentionDecision: RetentionDecisionSchema,
    retentionMode: RetentionModeSchema,
    sessionExpiresAt: IsoTimestampSchema,
    freshUntil: v.nullable(IsoTimestampSchema),
    displayUntil: v.nullable(IsoTimestampSchema),
    retentionUntil: v.nullable(IsoTimestampSchema),
    deletionScheduledAt: v.nullable(IsoTimestampSchema),
    attribution: v.nullable(AttributionSchema),
    restoreMode: RestoreModeSchema,
    policyStatus: PolicyStatusSchema,
    displayPolicyStatus: DisplayPolicyStatusSchema,
  }),
  v.check((metadata) => {
    const indefinite = metadata.retentionMode === 'identifier_indefinite_owner_scoped';
    const windowsFitSession =
      atOrBefore(metadata.freshUntil, metadata.sessionExpiresAt) &&
      atOrBefore(metadata.displayUntil, metadata.sessionExpiresAt) &&
      atOrBefore(metadata.retentionUntil, metadata.sessionExpiresAt) &&
      atOrBefore(metadata.freshUntil, metadata.displayUntil);

    if (!windowsFitSession) return false;

    if (metadata.retentionDecision === 'allow') {
      if (
        metadata.policyStatus !== 'available' ||
        metadata.retentionMode === 'none' ||
        metadata.restoreMode === 'unavailable'
      ) {
        return false;
      }
      if (indefinite) {
        return (
          metadata.retentionUntil === null &&
          metadata.freshUntil === null &&
          metadata.displayUntil === null &&
          metadata.deletionScheduledAt === null &&
          metadata.restoreMode === 'reference_only'
        );
      }
      return (
        metadata.retentionUntil !== null &&
        metadata.deletionScheduledAt !== null &&
        (metadata.freshUntil === null || metadata.displayUntil !== null) &&
        atOrBefore(metadata.freshUntil, metadata.displayUntil) &&
        atOrBefore(metadata.displayUntil, metadata.retentionUntil) &&
        atOrBefore(metadata.deletionScheduledAt, metadata.retentionUntil)
      );
    }

    return (
      metadata.retentionUntil === null &&
      metadata.deletionScheduledAt === null &&
      metadata.restoreMode !== 'full' &&
      !indefinite
    );
  }, 'retention decision and expiry are inconsistent'),
);
export type RetentionMetadata = v.InferOutput<typeof RetentionMetadataSchema>;

export const retentionDoesNotExceed = (target: RetentionMetadata, source: RetentionMetadata) => {
  const noLater = (candidate: string | null, bound: string | null) =>
    candidate === null || (bound !== null && Date.parse(candidate) <= Date.parse(bound));
  const noLaterOrAbsent = (candidate: string | null, bound: string | null) =>
    bound === null ? candidate === null : noLater(candidate, bound);

  return (
    Date.parse(target.sessionExpiresAt) <= Date.parse(source.sessionExpiresAt) &&
    (source.displayPolicyStatus === 'available' || target.displayPolicyStatus !== 'available') &&
    noLaterOrAbsent(target.freshUntil, source.freshUntil) &&
    noLaterOrAbsent(target.displayUntil, source.displayUntil) &&
    (target.retentionDecision !== 'allow' ||
      (source.retentionUntil !== null &&
        target.retentionUntil !== null &&
        noLater(target.retentionUntil, source.retentionUntil)))
  );
};
