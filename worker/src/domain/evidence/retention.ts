import * as v from 'valibot';
import { HttpsUrlSchema, IsoTimestampSchema, Text } from '@worker/domain/primitives';

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

const earliestOf = (values: readonly (string | null)[]): string | null => {
  let earliest: string | null = null;
  for (const value of values) {
    if (value !== null && (earliest === null || Date.parse(value) < Date.parse(earliest))) {
      earliest = value;
    }
  }
  return earliest;
};

const firstRestricted = <Status extends string>(
  values: readonly Status[],
  open: Status,
): Status | undefined => values.find((value) => value !== open);

/** Fails closed: nothing may be stored, and the body is gone at the session end. */
const denyRetentionUntil = (sessionExpiresAt: string): RetentionMetadata => ({
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  sessionExpiresAt,
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'unavailable',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
});

/**
 * The retention of text derived from several inputs: no deadline is later than any input's, it
 * is stored only when every input may be stored, and it is displayable only when every input is.
 * A `null` deadline means the input sets none, so it never widens another input's deadline.
 */
export const narrowRetention = (
  base: RetentionMetadata,
  sources: readonly RetentionMetadata[],
): RetentionMetadata => {
  const all = [base, ...sources];
  const sessionExpiresAt =
    earliestOf(all.map((item) => item.sessionExpiresAt)) ?? base.sessionExpiresAt;
  const storable = all.every(
    (item) =>
      item.retentionDecision === 'allow' &&
      item.retentionMode !== 'identifier_indefinite_owner_scoped' &&
      item.retentionUntil !== null &&
      item.deletionScheduledAt !== null,
  );
  const cap = (value: string | null, bound: string | null) => earliestOf([value, bound]) ?? value;
  const retentionUntil = storable
    ? cap(earliestOf(all.map((item) => item.retentionUntil)), sessionExpiresAt)
    : null;
  const deletionScheduledAt = storable
    ? cap(earliestOf(all.map((item) => item.deletionScheduledAt)), retentionUntil)
    : null;
  const listedDisplayUntil = cap(
    cap(earliestOf(all.map((item) => item.displayUntil)), retentionUntil),
    sessionExpiresAt,
  );
  const freshUntil = cap(
    cap(earliestOf(all.map((item) => item.freshUntil)), listedDisplayUntil),
    sessionExpiresAt,
  );
  // A stored text with a freshness deadline also needs a display deadline.
  const displayUntil =
    storable && freshUntil !== null ? (listedDisplayUntil ?? retentionUntil) : listedDisplayUntil;
  const displayPolicyStatus =
    firstRestricted(
      all.map((item) => item.displayPolicyStatus),
      'available',
    ) ?? 'available';
  const narrowed: RetentionMetadata = storable
    ? {
        retentionDecision: 'allow',
        retentionMode: all.some((item) => item.retentionMode === 'session_only')
          ? 'session_only'
          : 'provider_limited',
        sessionExpiresAt,
        freshUntil,
        displayUntil,
        retentionUntil,
        deletionScheduledAt,
        attribution:
          base.attribution ??
          sources.find((item) => item.attribution !== null)?.attribution ??
          null,
        restoreMode: all.some((item) => item.restoreMode !== 'full') ? 'reference_only' : 'full',
        policyStatus: 'available',
        displayPolicyStatus,
      }
    : {
        retentionDecision: all.some((item) => item.retentionDecision === 'deny')
          ? 'deny'
          : all.some((item) => item.retentionDecision === 'unknown')
            ? 'unknown'
            : 'deny',
        retentionMode: all.some((item) => item.retentionMode === 'none') ? 'none' : 'session_only',
        sessionExpiresAt,
        freshUntil,
        displayUntil,
        retentionUntil: null,
        deletionScheduledAt: null,
        attribution:
          base.attribution ??
          sources.find((item) => item.attribution !== null)?.attribution ??
          null,
        restoreMode: all.some((item) => item.restoreMode === 'unavailable')
          ? 'unavailable'
          : 'reference_only',
        policyStatus:
          firstRestricted(
            all.map((item) => item.policyStatus),
            'available',
          ) ?? 'policy_withheld',
        displayPolicyStatus,
      };
  const parsed = v.safeParse(RetentionMetadataSchema, narrowed);
  return parsed.success ? parsed.output : denyRetentionUntil(sessionExpiresAt);
};

/** Ends every window of `retention` no later than `deadline`, e.g. a quoted message's expiry. */
export const capRetention = (retention: RetentionMetadata, deadline: string): RetentionMetadata => {
  const cap = (value: string | null) =>
    value === null || Date.parse(value) <= Date.parse(deadline) ? value : deadline;
  const sessionExpiresAt = cap(retention.sessionExpiresAt) ?? deadline;
  const parsed = v.safeParse(RetentionMetadataSchema, {
    ...retention,
    sessionExpiresAt,
    freshUntil: cap(retention.freshUntil),
    displayUntil: cap(retention.displayUntil),
    retentionUntil: cap(retention.retentionUntil),
    deletionScheduledAt: cap(retention.deletionScheduledAt),
  });
  return parsed.success ? parsed.output : denyRetentionUntil(sessionExpiresAt);
};
