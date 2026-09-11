import * as v from 'valibot';
import {
  OpeningHoursSchema,
  ObservationSchema,
  RetentionMetadataSchema,
  SourceRefSchema,
  retentionDoesNotExceed,
  type OpeningHours,
  type RetentionMetadata,
  type SourceRef,
} from '@ima/core';
import type { HotPepperOpeningHoursSupplement } from './types';

const nonBlankLastOrder = v.pipe(
  v.string(),
  v.maxLength(160),
  v.check((value) => value.trim().length > 0, 'last-order text must not be blank'),
);

export type HotPepperOpeningHoursMerge =
  | { readonly status: 'merged'; readonly value: OpeningHours }
  | { readonly status: 'unchanged' }
  | { readonly status: 'conflict'; readonly reason: string };

export type OpeningHoursObservation = v.InferOutput<
  ReturnType<typeof ObservationSchema<typeof OpeningHoursSchema>>
>;

/** Adds only the explicitly reported LO text to an existing Core opening-hours value. */
export const mergeHotPepperOpeningHours = (
  base: unknown,
  supplement: HotPepperOpeningHoursSupplement,
): HotPepperOpeningHoursMerge => {
  const parsedBase = v.safeParse(OpeningHoursSchema, base);
  if (!parsedBase.success) {
    return { status: 'conflict', reason: 'Google opening-hours value is invalid' };
  }
  if (supplement.lastOrderRaw === null) return { status: 'unchanged' };
  if (!v.safeParse(nonBlankLastOrder, supplement.lastOrderRaw).success) {
    return { status: 'conflict', reason: 'Hot Pepper last-order text is invalid' };
  }
  if (parsedBase.output.lastOrderAt !== null) {
    return {
      status: 'conflict',
      reason: 'existing opening-hours last-order instant is authoritative',
    };
  }
  if (parsedBase.output.lastOrderRaw !== null) {
    return parsedBase.output.lastOrderRaw === supplement.lastOrderRaw
      ? { status: 'unchanged' }
      : { status: 'conflict', reason: 'opening-hours last-order values conflict' };
  }
  const parsed = v.safeParse(OpeningHoursSchema, {
    ...parsedBase.output,
    lastOrderRaw: supplement.lastOrderRaw,
    lastOrderAt: parsedBase.output.lastOrderAt,
  });
  return parsed.success
    ? { status: 'merged', value: parsed.output }
    : { status: 'conflict', reason: 'merged opening-hours value is invalid' };
};

/** A known Google opening observation is the only value that can receive an HP LO supplement. */
export const openingHoursNeedsHotPepper = (value: unknown): boolean => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('status' in value) ||
    value.status !== 'known' ||
    !('observations' in value) ||
    !Array.isArray(value.observations)
  ) {
    return false;
  }
  return value.observations.some((observation) => {
    const parsed = v.safeParse(ObservationSchema(OpeningHoursSchema), observation);
    return (
      parsed.success &&
      parsed.output.value.lastOrderRaw === null &&
      parsed.output.sources.some((source) => source.provider === 'google_places')
    );
  });
};

const sourceKey = (source: SourceRef): string =>
  JSON.stringify([source.provider, source.recordRef, source.attribution, source.publicUrl]);

export const mergeHotPepperOpeningSources = (
  base: readonly SourceRef[],
  supplement: SourceRef,
): readonly SourceRef[] | undefined => {
  const parsedBase = base.map((source) => v.safeParse(SourceRefSchema, source));
  if (parsedBase.some((result) => !result.success)) return undefined;
  const parsedSupplement = v.safeParse(SourceRefSchema, supplement);
  if (!parsedSupplement.success) return undefined;
  const sources = parsedBase.map((result) => (result.success ? result.output : undefined));
  if (sources.some((source) => source === undefined)) return undefined;
  const result = [...sources.filter((source): source is SourceRef => source !== undefined)];
  if (!result.some((source) => sourceKey(source) === sourceKey(parsedSupplement.output))) {
    result.push(parsedSupplement.output);
  }
  return result;
};

const commonBound = (left: string | null, right: string | null): string | null | undefined => {
  if (left === null && right === null) return null;
  if (left === null || right === null) return undefined;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return null;
  return leftMs <= rightMs ? left : right;
};

const commonSessionExpiry = (left: string, right: string): string | undefined => {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return undefined;
  return leftMs <= rightMs ? left : right;
};

const nonAvailableStatus = (
  left: RetentionMetadata['policyStatus'],
  right: RetentionMetadata['policyStatus'],
): RetentionMetadata['policyStatus'] => (left !== 'available' ? left : right);

const displayStatus = (
  left: RetentionMetadata['displayPolicyStatus'],
  right: RetentionMetadata['displayPolicyStatus'],
): RetentionMetadata['displayPolicyStatus'] => (left !== 'available' ? left : right);

const decisionFor = (
  left: RetentionMetadata,
  right: RetentionMetadata,
): RetentionMetadata['retentionDecision'] => {
  if (left.retentionDecision === 'deny' || right.retentionDecision === 'deny') return 'deny';
  if (left.retentionDecision === 'unknown' || right.retentionDecision === 'unknown') {
    return 'unknown';
  }
  return 'allow';
};

const deniedRetention = (
  left: RetentionMetadata,
  right: RetentionMetadata,
  decision: 'deny' | 'unknown',
  sessionExpiresAt: string,
): RetentionMetadata | undefined => {
  const freshUntil = commonBound(left.freshUntil, right.freshUntil);
  const displayUntil = commonBound(left.displayUntil, right.displayUntil);
  if (freshUntil === undefined || displayUntil === undefined) return undefined;
  const candidate: RetentionMetadata = {
    retentionDecision: decision,
    retentionMode: 'session_only',
    sessionExpiresAt,
    freshUntil,
    displayUntil,
    retentionUntil: null,
    deletionScheduledAt: null,
    attribution: right.attribution ?? left.attribution,
    restoreMode: 'unavailable',
    policyStatus: nonAvailableStatus(left.policyStatus, right.policyStatus),
    displayPolicyStatus: displayStatus(left.displayPolicyStatus, right.displayPolicyStatus),
  };
  const parsed = v.safeParse(RetentionMetadataSchema, candidate);
  return parsed.success ? parsed.output : undefined;
};

/** Intersects bounds; a one-sided missing bound rejects the merged observation. */
export const intersectHotPepperOpeningRetention = (
  base: RetentionMetadata,
  hotPepper: RetentionMetadata,
): RetentionMetadata | undefined => {
  if (
    !v.safeParse(RetentionMetadataSchema, base).success ||
    !v.safeParse(RetentionMetadataSchema, hotPepper).success
  ) {
    return undefined;
  }
  const sessionExpiresAt = commonSessionExpiry(base.sessionExpiresAt, hotPepper.sessionExpiresAt);
  if (sessionExpiresAt === undefined) return undefined;
  const decision = decisionFor(base, hotPepper);
  if (decision !== 'allow') return deniedRetention(base, hotPepper, decision, sessionExpiresAt);
  const freshUntil = commonBound(base.freshUntil, hotPepper.freshUntil);
  const displayUntil = commonBound(base.displayUntil, hotPepper.displayUntil);
  const retentionUntil = commonBound(base.retentionUntil, hotPepper.retentionUntil);
  const deletionScheduledAt = commonBound(base.deletionScheduledAt, hotPepper.deletionScheduledAt);
  if (
    freshUntil === undefined ||
    displayUntil === undefined ||
    retentionUntil === undefined ||
    deletionScheduledAt === undefined
  ) {
    return undefined;
  }
  const mode =
    base.retentionMode === 'provider_limited' || hotPepper.retentionMode === 'provider_limited'
      ? 'provider_limited'
      : base.retentionMode === 'session_only' || hotPepper.retentionMode === 'session_only'
        ? 'session_only'
        : 'identifier_indefinite_owner_scoped';
  const indefinite = mode === 'identifier_indefinite_owner_scoped';
  const candidate: RetentionMetadata = {
    retentionDecision: 'allow',
    retentionMode: mode,
    sessionExpiresAt,
    freshUntil,
    displayUntil,
    retentionUntil: indefinite ? null : retentionUntil,
    deletionScheduledAt: indefinite ? null : deletionScheduledAt,
    attribution: hotPepper.attribution ?? base.attribution,
    restoreMode:
      base.restoreMode === 'full' && hotPepper.restoreMode === 'full' ? 'full' : 'reference_only',
    policyStatus:
      base.policyStatus === 'available' && hotPepper.policyStatus === 'available'
        ? 'available'
        : nonAvailableStatus(base.policyStatus, hotPepper.policyStatus),
    displayPolicyStatus: displayStatus(base.displayPolicyStatus, hotPepper.displayPolicyStatus),
  };
  const parsed = v.safeParse(RetentionMetadataSchema, candidate);
  if (!parsed.success || !retentionDoesNotExceed(parsed.output, base)) return undefined;
  return retentionDoesNotExceed(parsed.output, hotPepper) ? parsed.output : undefined;
};
