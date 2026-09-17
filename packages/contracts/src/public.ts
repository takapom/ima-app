import * as v from 'valibot';
import {
  CandidateIdSchema,
  HttpsUrlSchema,
  IsoTimestampSchema,
  OpaqueIdSchema,
  Text,
} from '@contracts/common';

const RestoreModeSchema = v.picklist(['full', 'reference_only', 'unavailable']);
const PolicyStatusSchema = v.picklist([
  'available',
  'policy_withheld',
  'disabled_m35',
  'disabled_capability',
  'attribution_missing',
  'expired',
]);
const DisplayPolicyStatusSchema = PolicyStatusSchema;

export const AttributionSchema = v.strictObject({
  label: Text(160),
  sourceLink: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});
export type Attribution = v.InferOutput<typeof AttributionSchema>;

export const RetentionMetadataSchema = v.pipe(
  v.strictObject({
    retentionDecision: v.picklist(['allow', 'deny', 'unknown']),
    retentionMode: v.picklist([
      'provider_limited',
      'identifier_indefinite_owner_scoped',
      'session_only',
      'none',
    ]),
    sessionExpiresAt: IsoTimestampSchema,
    freshUntil: v.nullable(IsoTimestampSchema),
    displayUntil: v.nullable(IsoTimestampSchema),
    retentionUntil: v.nullable(IsoTimestampSchema),
    deletionScheduledAt: v.nullable(IsoTimestampSchema),
    attribution: v.nullable(AttributionSchema),
    restoreMode: RestoreModeSchema,
    /** Storage/retention policy only; display has its own status below. */
    policyStatus: PolicyStatusSchema,
    displayPolicyStatus: DisplayPolicyStatusSchema,
  }),
  v.check((metadata) => {
    const indefinite = metadata.retentionMode === 'identifier_indefinite_owner_scoped';

    const atOrBefore = (left: string | null, right: string | null) =>
      left === null || right === null || Date.parse(left) <= Date.parse(right);

    if (
      !atOrBefore(metadata.freshUntil, metadata.sessionExpiresAt) ||
      !atOrBefore(metadata.displayUntil, metadata.sessionExpiresAt) ||
      !atOrBefore(metadata.freshUntil, metadata.displayUntil)
    ) {
      return false;
    }

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
        atOrBefore(metadata.retentionUntil, metadata.sessionExpiresAt) &&
        atOrBefore(metadata.freshUntil, metadata.displayUntil) &&
        atOrBefore(metadata.displayUntil, metadata.retentionUntil) &&
        atOrBefore(metadata.deletionScheduledAt, metadata.retentionUntil)
      );
    }

    return (
      metadata.retentionUntil === null &&
      metadata.deletionScheduledAt === null &&
      metadata.restoreMode !== 'full' &&
      metadata.retentionMode !== 'identifier_indefinite_owner_scoped'
    );
  }, 'retention decision and expiry are inconsistent'),
);
export type RetentionMetadata = v.InferOutput<typeof RetentionMetadataSchema>;

/** Runtime boundary helper for clients that persist public retention metadata. */
export const parseRetentionMetadata = (input: unknown): RetentionMetadata | null => {
  const parsed = v.safeParse(RetentionMetadataSchema, input);
  return parsed.success ? parsed.output : null;
};

/** Minimal evidence metadata safe for mobile rendering; provider records stay internal. */
const EvidenceAttributionsSchema = v.pipe(
  v.array(AttributionSchema),
  v.minLength(1),
  // Core permits eight source refs; retention may carry one additional policy credit.
  v.maxLength(9),
);

export const EvidenceRefSchema = v.strictObject({
  evidenceId: OpaqueIdSchema,
  attribution: v.nullable(AttributionSchema),
  /** Credits from every public source; provider IDs and record references stay internal. */
  attributions: v.optional(EvidenceAttributionsSchema),
  retention: RetentionMetadataSchema,
});
export type EvidenceRef = v.InferOutput<typeof EvidenceRefSchema>;

const uniqueEvidenceRefs = v.check(
  (items: EvidenceRef[]) => new Set(items.map((item) => item.evidenceId)).size === items.length,
  'evidence IDs must be unique',
);
const EvidenceRefsSchema = v.pipe(v.array(EvidenceRefSchema), v.minLength(1), uniqueEvidenceRefs);
const OptionalEvidenceRefsSchema = v.pipe(v.array(EvidenceRefSchema), uniqueEvidenceRefs);

export const DisplayFieldSchema = <T extends v.GenericSchema>(value: T) =>
  v.variant('status', [
    v.strictObject({
      status: v.literal('known'),
      value,
      evidence: EvidenceRefsSchema,
    }),
    v.strictObject({
      status: v.picklist(['unknown', 'unsupported', 'not_applicable']),
      reason: Text(300),
    }),
    v.strictObject({
      status: v.literal('error'),
      code: v.picklist(['PROVIDER_UNAVAILABLE', 'MISSING_EVIDENCE', 'INTERNAL']),
      reason: Text(300),
    }),
  ]);

/** Text shown on the device carries explicit evidence and retention policy. */
export const PublicEvidenceTextSchema = (maxLength: number) =>
  v.pipe(
    v.strictObject({
      text: Text(maxLength),
      evidenceIds: v.array(OpaqueIdSchema),
      evidence: OptionalEvidenceRefsSchema,
      basis: v.picklist(['grounded', 'inference', 'conversational']),
      retention: RetentionMetadataSchema,
    }),
    v.check((value) => {
      const ids = new Set(value.evidence.map((item) => item.evidenceId));
      const sourceAllowsPersistence = value.evidence.every(
        (item) => item.retention.retentionDecision === 'allow',
      );
      const textDoesNotExceedSource = value.evidence.every((item) => {
        const source = item.retention;
        const noLaterThan = (candidate: string | null, bound: string | null) =>
          candidate === null || (bound !== null && Date.parse(candidate) <= Date.parse(bound));
        const noLaterThanOrAbsent = (candidate: string | null, bound: string | null) =>
          bound === null ? candidate === null : noLaterThan(candidate, bound);
        return (
          Date.parse(value.retention.sessionExpiresAt) <= Date.parse(source.sessionExpiresAt) &&
          (source.displayPolicyStatus === 'available' ||
            value.retention.displayPolicyStatus !== 'available') &&
          noLaterThanOrAbsent(value.retention.freshUntil, source.freshUntil) &&
          noLaterThanOrAbsent(value.retention.displayUntil, source.displayUntil) &&
          (value.retention.retentionDecision !== 'allow' ||
            (source.retentionUntil !== null &&
              value.retention.retentionUntil !== null &&
              noLaterThan(value.retention.retentionUntil, source.retentionUntil)))
        );
      });
      return (
        new Set(value.evidenceIds).size === value.evidenceIds.length &&
        value.evidenceIds.every((id) => ids.has(id)) &&
        value.evidence.every((item) => value.evidenceIds.includes(item.evidenceId)) &&
        (value.basis !== 'grounded' || value.evidenceIds.length > 0) &&
        (value.evidence.length === 0 ||
          value.retention.retentionDecision !== 'allow' ||
          sourceAllowsPersistence) &&
        (value.evidence.length === 0 || textDoesNotExceedSource)
      );
    }, 'message evidence IDs must reference its evidence metadata'),
  );

export const PublicCandidateRefSchema = v.strictObject({
  candidateId: CandidateIdSchema,
  evidenceIds: v.array(OpaqueIdSchema),
});
