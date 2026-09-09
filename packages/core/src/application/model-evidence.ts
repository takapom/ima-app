import * as v from 'valibot';
import {
  DetailFieldSchema,
  RetentionMetadataSchema,
  SourceRefSchema,
  type RegistryJsonValue,
  type RetentionMetadata,
} from '../domain';
import {
  ContactInfoSchema,
  FacilitiesInfoSchema,
  LastTrainInfoSchema,
  OpeningHoursSchema,
  PhotoInfoSchema,
  PlaceIdentitySchema,
  PriceInfoSchema,
  WalkingRouteSchema,
} from '../domain/place-values';
import {
  CandidateIdSchema,
  IsoTimestampSchema,
  ObservationIdSchema,
  OpaqueIdSchema,
  type DetailField,
} from '../domain/primitives';
import { ModelContextError } from './model-context-errors';

export const ModelEvidenceSourceSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  threadId: OpaqueIdSchema,
  observationId: ObservationIdSchema,
  candidateId: CandidateIdSchema,
  field: DetailFieldSchema,
  value: v.unknown(),
  fetchedAt: IsoTimestampSchema,
  freshUntil: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  sources: v.pipe(v.array(SourceRefSchema), v.minLength(1), v.maxLength(8)),
  retention: RetentionMetadataSchema,
});
export type ModelEvidenceSource = v.InferOutput<typeof ModelEvidenceSourceSchema>;

export type ModelEvidenceAvailabilityInput = {
  readonly now: string;
  readonly fetchedAt: string;
  readonly freshUntil: string | null;
  readonly expiresAt: string;
  readonly retention: RetentionMetadata;
};

export type ModelEvidenceAvailability =
  | { readonly status: 'available' }
  | { readonly status: 'withheld'; readonly reason: string }
  | { readonly status: 'stale'; readonly reason: string };

/** Shared freshness gate; a null policy bound does not remove local source freshness. */
export const evaluateModelEvidenceAvailability = (
  input: ModelEvidenceAvailabilityInput,
): ModelEvidenceAvailability => {
  const { now, fetchedAt, freshUntil, expiresAt, retention } = input;
  const nowMs = Date.parse(now);
  const fetchedAtMs = Date.parse(fetchedAt);
  const sourceFreshUntilMs = freshUntil === null ? null : Date.parse(freshUntil);
  const sourceExpiresAtMs = Date.parse(expiresAt);
  const policyBoundaries = [
    retention.sessionExpiresAt,
    retention.freshUntil,
    retention.displayUntil,
    retention.retentionUntil,
    retention.deletionScheduledAt,
  ];
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(fetchedAtMs) ||
    (sourceFreshUntilMs !== null && !Number.isFinite(sourceFreshUntilMs)) ||
    !Number.isFinite(sourceExpiresAtMs) ||
    fetchedAtMs > nowMs ||
    fetchedAtMs > sourceExpiresAtMs ||
    (sourceFreshUntilMs !== null && fetchedAtMs > sourceFreshUntilMs) ||
    (sourceFreshUntilMs !== null && sourceFreshUntilMs > sourceExpiresAtMs)
  ) {
    return { status: 'stale', reason: 'evidence timestamps are invalid' };
  }
  if (
    policyBoundaries.some((boundary) => boundary !== null && !Number.isFinite(Date.parse(boundary)))
  ) {
    return { status: 'withheld', reason: 'evidence policy window is invalid' };
  }
  if (
    retention.retentionDecision !== 'allow' ||
    retention.policyStatus !== 'available' ||
    retention.displayPolicyStatus !== 'available'
  ) {
    return { status: 'withheld', reason: 'evidence policy does not allow model input' };
  }
  const policyExpiry = policyBoundaries.find(
    (boundary) => boundary !== null && nowMs >= Date.parse(boundary),
  );
  if (policyExpiry !== undefined) {
    return { status: 'withheld', reason: 'evidence retention window has ended' };
  }
  if (sourceFreshUntilMs === null || nowMs >= sourceFreshUntilMs || nowMs >= sourceExpiresAtMs) {
    return { status: 'stale', reason: 'evidence is outside its usable freshness window' };
  }
  return { status: 'available' };
};

export type ModelEvidence =
  | {
      readonly status: 'known';
      readonly observationId: string;
      readonly candidateId: string;
      readonly field: DetailField;
      readonly value: RegistryJsonValue;
      readonly fetchedAt: string;
      readonly freshUntil: string;
      readonly expiresAt: string;
      readonly sources: readonly {
        readonly provider: string;
        readonly attribution: string | null;
        readonly publicUrl: string | null;
      }[];
    }
  | {
      readonly status: 'withheld' | 'stale';
      readonly observationId: string;
      readonly candidateId: string;
      readonly field: DetailField;
      readonly reason: string;
      readonly freshUntil: string | null;
    };

const cloneJsonValue = (value: unknown, stack = new Set<object>()): RegistryJsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new ModelContextError('INVALID_EVIDENCE', 'evidence value is not finite JSON');
  }
  if (typeof value !== 'object' || stack.has(value)) {
    throw new ModelContextError('INVALID_EVIDENCE', 'evidence value is not plain JSON');
  }
  stack.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => cloneJsonValue(item, stack));
    stack.delete(value);
    return result;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ModelContextError('INVALID_EVIDENCE', 'evidence value is not a plain object');
  }
  const result: { [key: string]: RegistryJsonValue } = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new ModelContextError('INVALID_EVIDENCE', 'evidence value has an invalid property');
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: cloneJsonValue(descriptor.value, stack),
      writable: true,
    });
  }
  stack.delete(value);
  return result;
};

const schemaForField = (field: DetailField): v.GenericSchema => {
  switch (field) {
    case 'identity':
      return PlaceIdentitySchema;
    case 'opening_hours':
      return OpeningHoursSchema;
    case 'price':
      return PriceInfoSchema;
    case 'photos':
      return PhotoInfoSchema;
    case 'contact':
      return ContactInfoSchema;
    case 'facilities':
      return FacilitiesInfoSchema;
    case 'walking_route':
      return WalkingRouteSchema;
    case 'last_train':
      return LastTrainInfoSchema;
  }
};

const projectEvidence = (source: ModelEvidenceSource, now: string): ModelEvidence => {
  const retention = source.retention;
  const retentionFreshUntil = retention.freshUntil;
  const locallyBound =
    retentionFreshUntil === null ||
    Date.parse(source.freshUntil) <= Date.parse(retentionFreshUntil);
  const sourceWindowsAreOrdered =
    Date.parse(source.fetchedAt) <= Date.parse(source.freshUntil) &&
    Date.parse(source.fetchedAt) <= Date.parse(source.expiresAt) &&
    Date.parse(source.freshUntil) <= Date.parse(source.expiresAt);
  if (!locallyBound || !sourceWindowsAreOrdered) {
    throw new ModelContextError('INVALID_EVIDENCE', 'evidence freshness exceeds policy freshness');
  }
  const availability = evaluateModelEvidenceAvailability({
    now,
    fetchedAt: source.fetchedAt,
    freshUntil: source.freshUntil,
    expiresAt: source.expiresAt,
    retention,
  });
  const effectiveFreshUntil = [
    source.freshUntil,
    source.expiresAt,
    retention.sessionExpiresAt,
    retention.freshUntil,
    retention.displayUntil,
    retention.retentionUntil,
    retention.deletionScheduledAt,
  ]
    .filter((boundary): boundary is string => boundary !== null)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  if (effectiveFreshUntil === undefined) {
    throw new ModelContextError('INVALID_EVIDENCE', 'evidence has no usable expiry boundary');
  }
  if (availability.status !== 'available') {
    return {
      status: availability.status,
      observationId: source.observationId,
      candidateId: source.candidateId,
      field: source.field,
      reason: availability.reason,
      freshUntil: effectiveFreshUntil,
    };
  }
  const parsed = v.safeParse(schemaForField(source.field), source.value);
  if (!parsed.success) {
    throw new ModelContextError('INVALID_EVIDENCE', 'evidence value does not match its field');
  }
  return {
    status: 'known',
    observationId: source.observationId,
    candidateId: source.candidateId,
    field: source.field,
    value: cloneJsonValue(parsed.output),
    fetchedAt: source.fetchedAt,
    freshUntil: effectiveFreshUntil,
    expiresAt: source.expiresAt,
    sources: source.sources.map((sourceRef) => ({
      provider: sourceRef.provider,
      attribution: sourceRef.attribution,
      publicUrl: sourceRef.publicUrl,
    })),
  };
};

/** Projects one registry observation to the model-safe evidence allowlist. */
export const projectModelEvidence = (source: unknown, now: unknown): ModelEvidence => {
  const parsedSource = v.safeParse(ModelEvidenceSourceSchema, source);
  const parsedNow = v.safeParse(IsoTimestampSchema, now);
  if (!parsedSource.success || !parsedNow.success) {
    throw new ModelContextError('INVALID_EVIDENCE', 'model evidence source or clock is invalid');
  }
  return projectEvidence(parsedSource.output, parsedNow.output);
};
