import * as v from 'valibot';
import {
  FacilitiesInfoSchema,
  ObservationSchema,
  OpeningHoursSchema,
  PriceInfoSchema,
  RetentionMetadataSchema,
  type SourceRef,
  type RetentionMetadata,
} from '@ima/core';
import type { HotPepperFieldPolicy, HotPepperPolicyRecord, HotPepperRuntimeMode } from './types';
import { hotPepperPolicyAllows, hotPepperPolicyRecordAllows } from './types';

export type HotPepperOverlayField = 'opening_hours' | 'price' | 'facilities';

type KnownFieldValue = {
  readonly status: 'known';
  readonly observations: readonly unknown[];
};

export const isKnown = (value: unknown): value is KnownFieldValue =>
  typeof value === 'object' &&
  value !== null &&
  'status' in value &&
  value.status === 'known' &&
  'observations' in value &&
  Array.isArray(value.observations);

const deniedPolicy: HotPepperPolicyRecord = {
  decision: 'deny',
  activation: 'disabled_until_m35',
};

const fieldPolicyFor = (
  policy: HotPepperFieldPolicy,
  field: HotPepperOverlayField,
  use: 'display' | 'persistence',
): HotPepperPolicyRecord => {
  try {
    return policy(field, use);
  } catch {
    return deniedPolicy;
  }
};

const policyStatusFor = (
  policy: HotPepperPolicyRecord,
  mode: HotPepperRuntimeMode,
): RetentionMetadata['policyStatus'] => {
  if (hotPepperPolicyRecordAllows(policy, mode)) return 'available';
  return policy.activation === 'disabled_until_m35' ? 'disabled_m35' : 'policy_withheld';
};

export const hotPepperFieldAllowed = (
  policy: HotPepperFieldPolicy,
  mode: HotPepperRuntimeMode,
  field: HotPepperOverlayField,
): boolean => hotPepperPolicyAllows(policy, field, 'llm_input', mode);

/** Applies current HP display/persistence decisions without elevating either policy. */
export const retentionFor = (
  policy: HotPepperFieldPolicy,
  mode: HotPepperRuntimeMode,
  field: HotPepperOverlayField,
  retention: RetentionMetadata,
): RetentionMetadata | undefined => {
  const displayPolicy = fieldPolicyFor(policy, field, 'display');
  const persistencePolicy = fieldPolicyFor(policy, field, 'persistence');
  const displayAllowed = hotPepperPolicyRecordAllows(displayPolicy, mode);
  const persistenceAllowed = hotPepperPolicyRecordAllows(persistencePolicy, mode);
  const next: RetentionMetadata = {
    ...retention,
    displayPolicyStatus: displayAllowed
      ? retention.displayPolicyStatus
      : policyStatusFor(displayPolicy, mode),
  };
  if (!persistenceAllowed) {
    next.retentionDecision = persistencePolicy.decision === 'unknown' ? 'unknown' : 'deny';
    next.retentionMode = 'session_only';
    next.retentionUntil = null;
    next.deletionScheduledAt = null;
    next.restoreMode = 'unavailable';
    next.policyStatus = policyStatusFor(persistencePolicy, mode);
  }
  const parsed = v.safeParse(RetentionMetadataSchema, next);
  return parsed.success ? parsed.output : undefined;
};

const hasHotPepperSource = (value: unknown): boolean => {
  if (!isKnown(value)) return false;
  return value.observations.some((observation) => {
    if (typeof observation !== 'object' || observation === null) return false;
    if (!('sources' in observation) || !Array.isArray(observation.sources)) return false;
    return observation.sources.some((source) => {
      if (typeof source !== 'object' || source === null || !('provider' in source)) return false;
      const provider = (source as { readonly provider?: unknown }).provider;
      return provider === 'hotpepper';
    });
  });
};

const hasMixedHotPepperSource = (value: KnownFieldValue): boolean =>
  value.observations.some((observation) => {
    if (typeof observation !== 'object' || observation === null) return true;
    if (!('sources' in observation) || !Array.isArray(observation.sources)) return true;
    const sources = observation.sources;
    const hasHotPepper = sources.some(
      (source) =>
        typeof source === 'object' &&
        source !== null &&
        'provider' in source &&
        (source as { readonly provider?: unknown }).provider === 'hotpepper',
    );
    return (
      hasHotPepper &&
      !sources.every(
        (source) =>
          typeof source === 'object' &&
          source !== null &&
          'provider' in source &&
          (source as { readonly provider?: unknown }).provider === 'hotpepper',
      )
    );
  });

const hasSupportedMixedOpeningSource = (value: KnownFieldValue): boolean =>
  value.observations.length > 0 &&
  value.observations.every((observation) => {
    if (typeof observation !== 'object' || observation === null) return false;
    if (!('sources' in observation) || !Array.isArray(observation.sources)) return false;
    const sources = observation.sources.filter(
      (source): source is { readonly provider: unknown } =>
        typeof source === 'object' && source !== null && 'provider' in source,
    );
    return (
      sources.length === observation.sources.length &&
      sources.some((source) => source.provider === 'hotpepper') &&
      sources.some((source) => source.provider === 'google_places') &&
      sources.every(
        (source) => source.provider === 'hotpepper' || source.provider === 'google_places',
      )
    );
  });

/** Reprojects an existing HP observation before either reuse or public output. */
export const reprojectHotPepperField = (
  policy: HotPepperFieldPolicy,
  mode: HotPepperRuntimeMode,
  field: HotPepperOverlayField,
  value: unknown,
): unknown => {
  if (!hasHotPepperSource(value)) return value;
  if (
    !hotPepperPolicyAllows(policy, 'source', 'attribution', mode) ||
    !hotPepperFieldAllowed(policy, mode, field)
  ) {
    return { status: 'unsupported', reason: 'Hot Pepper field is withheld by provider policy' };
  }
  if (!isKnown(value)) {
    return { status: 'unsupported', reason: 'Hot Pepper field has mixed provider sources' };
  }
  if (
    hasMixedHotPepperSource(value) &&
    (field !== 'opening_hours' || !hasSupportedMixedOpeningSource(value))
  ) {
    return { status: 'unsupported', reason: 'Hot Pepper field has mixed provider sources' };
  }
  const schema =
    field === 'facilities'
      ? FacilitiesInfoSchema
      : field === 'price'
        ? PriceInfoSchema
        : OpeningHoursSchema;
  const observations = value.observations.map((observation) => {
    const parsed = v.safeParse(ObservationSchema(schema), observation);
    if (!parsed.success) return undefined;
    const retention = retentionFor(policy, mode, field, parsed.output.retention);
    return retention === undefined ? undefined : { ...parsed.output, retention };
  });
  return observations.every(
    (observation): observation is NonNullable<typeof observation> => observation !== undefined,
  )
    ? { status: 'known', observations }
    : { status: 'unsupported', reason: 'Hot Pepper field retention policy is unavailable' };
};

/** Reprojects the immutable registry metadata at the final public evidence boundary. */
export const reprojectHotPepperObservationRetention = (
  policy: HotPepperFieldPolicy,
  mode: HotPepperRuntimeMode,
  field: string,
  sources: readonly SourceRef[],
  retention: RetentionMetadata,
): RetentionMetadata | undefined => {
  const hasHotPepper = sources.some((source) => source.provider === 'hotpepper');
  if (!hasHotPepper) return retention;
  const allHotPepper =
    sources.length > 0 && sources.every((source) => source.provider === 'hotpepper');
  const mixedOpening =
    field === 'opening_hours' &&
    sources.some((source) => source.provider === 'google_places') &&
    sources.every(
      (source) => source.provider === 'hotpepper' || source.provider === 'google_places',
    );
  if (
    (field !== 'price' && field !== 'facilities' && field !== 'opening_hours') ||
    (!allHotPepper && !mixedOpening)
  ) {
    return undefined;
  }
  if (!hotPepperPolicyAllows(policy, 'source', 'attribution', mode)) return undefined;
  if (!hotPepperFieldAllowed(policy, mode, field)) return undefined;
  return retentionFor(policy, mode, field, retention);
};
