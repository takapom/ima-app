import type { JSONValue } from 'ai';
import * as v from 'valibot';
import { CandidateIdSchema, type DetailField } from '@worker/domain/primitives';
import {
  ContactInfoSchema,
  FacilitiesInfoSchema,
  OpeningHoursSchema,
  PhotoInfoSchema,
  PlaceIdentitySchema,
  PriceInfoSchema,
} from '@worker/domain/places/place-values';
import { IssueCodeSchema } from '@worker/domain/issue';
import {
  modelContextFieldAllowed,
  modelEvidenceFieldDecision,
  type ModelContextFieldDecision,
  type ModelContextFieldPolicy,
} from '@worker/application/model-context/model-context-policy';

export type RuntimePolicyMode = 'fixture' | 'live';
export type RuntimeFieldUse = 'llm_input' | 'display' | 'persistence';
export type RuntimePolicyDecision = 'allow' | 'deny' | 'unknown';
export type RuntimePolicyActivation =
  'fixture_only' | 'disabled_until_m35' | 'live_verified' | 'app_configured';
export type RuntimeFieldStatus = 'known' | 'unknown' | 'unsupported' | 'error';
export type RuntimePolicyStatus =
  | 'available'
  | 'policy_withheld'
  | 'disabled_m35'
  | 'disabled_capability'
  | 'attribution_missing'
  | 'expired';

/** One provider field's decision for one use. The three uses never inherit each other. */
export type RuntimePolicyRecord = {
  readonly decision: RuntimePolicyDecision;
  readonly activation: RuntimePolicyActivation;
  readonly fieldStatus: RuntimeFieldStatus;
  readonly policyStatus: RuntimePolicyStatus;
};

export type RuntimeFieldUsePolicy = {
  readonly llm_input: RuntimePolicyRecord;
  readonly display: RuntimePolicyRecord;
  readonly persistence: RuntimePolicyRecord;
};

/** Host input for model projection; evidence remains field-specific. */
export type RuntimeModelProjectionPolicyInput = {
  readonly evidence: Readonly<Record<DetailField, RuntimeFieldUsePolicy>>;
  readonly history: RuntimeFieldUsePolicy;
  readonly cardSet: RuntimeFieldUsePolicy;
  readonly displayName: RuntimeFieldUsePolicy;
};

/** Shared by response/photo adapters so display and persistence do not reuse LLM decisions. */
export const runtimePolicyAllows = (
  policy: RuntimeFieldUsePolicy,
  use: RuntimeFieldUse,
  mode: RuntimePolicyMode,
): boolean => {
  const record = policy[use];
  if (record.decision !== 'allow' || record.fieldStatus !== 'known') return false;
  if (record.policyStatus !== 'available') return false;
  if (record.activation === 'disabled_until_m35') return false;
  if (record.activation === 'fixture_only') return mode === 'fixture';
  return record.activation === 'live_verified' || record.activation === 'app_configured';
};

const modelDecision = (
  policy: RuntimeFieldUsePolicy,
  mode: RuntimePolicyMode,
): ModelContextFieldDecision => (runtimePolicyAllows(policy, 'llm_input', mode) ? 'allow' : 'deny');

/** Converts an evaluated Worker snapshot to the Core model-input contract. */
export const toModelContextFieldPolicy = (
  input: RuntimeModelProjectionPolicyInput,
  mode: RuntimePolicyMode,
): ModelContextFieldPolicy => ({
  evidence: {
    identity: modelDecision(input.evidence.identity, mode),
    opening_hours: modelDecision(input.evidence.opening_hours, mode),
    price: modelDecision(input.evidence.price, mode),
    photos: modelDecision(input.evidence.photos, mode),
    contact: modelDecision(input.evidence.contact, mode),
    facilities: modelDecision(input.evidence.facilities, mode),
  },
  history: modelDecision(input.history, mode),
  cardSet: modelDecision(input.cardSet, mode),
  displayName: modelDecision(input.displayName, mode),
});

const disabledRecord = (): RuntimePolicyRecord => ({
  decision: 'unknown',
  activation: 'disabled_until_m35',
  fieldStatus: 'unknown',
  policyStatus: 'disabled_m35',
});

const disabledUses = (): RuntimeFieldUsePolicy => ({
  llm_input: disabledRecord(),
  display: disabledRecord(),
  persistence: disabledRecord(),
});

/** Production default. No provider field reaches a model or display until a host snapshot allows it. */
export const defaultRuntimeModelProjectionPolicy: RuntimeModelProjectionPolicyInput = {
  evidence: {
    identity: disabledUses(),
    opening_hours: disabledUses(),
    price: disabledUses(),
    photos: disabledUses(),
    contact: disabledUses(),
    facilities: disabledUses(),
  },
  history: disabledUses(),
  cardSet: disabledUses(),
  displayName: disabledUses(),
};

export const defaultRuntimeModelContextPolicy = toModelContextFieldPolicy(
  defaultRuntimeModelProjectionPolicy,
  'live',
);

type JsonRecord = { readonly [key: string]: JSONValue };

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDetailField = (value: string): value is DetailField =>
  value === 'identity' ||
  value === 'opening_hours' ||
  value === 'price' ||
  value === 'photos' ||
  value === 'contact' ||
  value === 'facilities';

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
  }
};

const knownResultField = (value: JSONValue): DetailField | undefined => {
  if (!isRecord(value) || value.status !== 'known' || !Array.isArray(value.observations)) {
    return undefined;
  }
  const fields = value.observations.map((observation) => {
    if (!isRecord(observation) || typeof observation.field !== 'string') return undefined;
    return isDetailField(observation.field) ? observation.field : undefined;
  });
  const first = fields[0];
  return first !== undefined && fields.every((field) => field === first) ? first : undefined;
};

const MODEL_INPUT_WITHHELD = {
  status: 'withheld',
  reason: 'model input policy denies this evidence field',
} as const;

/** Keep the model boundary in sync with Core; unknown provider codes remain unavailable. */
const isIssueCode = (value: string): boolean => v.safeParse(IssueCodeSchema, value).success;

const safeIssue = (value: JSONValue): JSONValue => {
  if (!isRecord(value))
    return { code: 'UPSTREAM_UNAVAILABLE', message: 'tool result is unavailable' };
  const code =
    typeof value.code === 'string' && isIssueCode(value.code) ? value.code : 'UPSTREAM_UNAVAILABLE';
  return {
    code,
    path: null,
    retryable: value.retryable === true,
    retryAfterMs:
      typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs)
        ? value.retryAfterMs
        : null,
    message: 'tool result is unavailable',
    missingFields: [],
  };
};

const safeSource = (value: JSONValue): JSONValue | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.provider !== 'string' ||
    (value.attribution !== null && typeof value.attribution !== 'string') ||
    (value.publicUrl !== null && typeof value.publicUrl !== 'string')
  ) {
    return undefined;
  }
  return {
    provider: value.provider,
    attribution: value.attribution,
    publicUrl: value.publicUrl,
  };
};

const safeObservation = (value: JSONValue, field: DetailField): JSONValue | undefined => {
  if (!isRecord(value) || value.field !== field) return undefined;
  const sourceValues = Array.isArray(value.sources) ? value.sources.map(safeSource) : undefined;
  const sources =
    sourceValues?.filter((source): source is JSONValue => source !== undefined) ?? undefined;
  if (
    typeof value.observationId !== 'string' ||
    typeof value.candidateId !== 'string' ||
    typeof value.fetchedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    (value.sourceUpdatedAt !== null && typeof value.sourceUpdatedAt !== 'string') ||
    (value.freshUntil !== null && typeof value.freshUntil !== 'string') ||
    sources === undefined ||
    sourceValues === undefined ||
    sources.length !== sourceValues.length ||
    value.value === undefined
  ) {
    return undefined;
  }
  if (!v.safeParse(schemaForField(field), value.value).success) return undefined;
  return {
    observationId: value.observationId,
    candidateId: value.candidateId,
    field,
    value: value.value,
    basis: value.basis === 'computed' ? 'computed' : 'provider_reported',
    fetchedAt: value.fetchedAt,
    sourceUpdatedAt: value.sourceUpdatedAt,
    expiresAt: value.expiresAt,
    freshUntil: value.freshUntil,
    sources,
  };
};

const unavailableField = (value: JsonRecord): JSONValue | undefined => {
  if (
    value.status !== 'unknown' &&
    value.status !== 'unsupported' &&
    value.status !== 'not_applicable' &&
    value.status !== 'withheld' &&
    value.status !== 'stale'
  ) {
    return undefined;
  }
  return { status: value.status, reason: 'field value is unavailable' };
};

/** Receives each observation whose value is passed to the model. */
export type RuntimePresentedObservation = (observationId: string) => void;

const projectFieldResult = (
  value: JSONValue,
  field: DetailField,
  policy: ModelContextFieldPolicy,
  presented: RuntimePresentedObservation | undefined,
): JSONValue => {
  if (!isRecord(value)) return MODEL_INPUT_WITHHELD;
  if (value.status === 'known') {
    if (!modelContextFieldAllowed(modelEvidenceFieldDecision(policy, field))) {
      return MODEL_INPUT_WITHHELD;
    }
    if (!Array.isArray(value.observations) || knownResultField(value) !== field) {
      return MODEL_INPUT_WITHHELD;
    }
    const observations = value.observations.map((observation) =>
      safeObservation(observation, field),
    );
    if (!observations.every((observation): observation is JSONValue => observation !== undefined))
      return MODEL_INPUT_WITHHELD;
    for (const observation of observations) {
      if (isRecord(observation) && typeof observation.observationId === 'string')
        presented?.(observation.observationId);
    }
    return { status: 'known', observations };
  }
  if (value.status === 'error') {
    return { status: 'error', error: safeIssue(value.error ?? null) };
  }
  return unavailableField(value) ?? MODEL_INPUT_WITHHELD;
};

const projectSearchData = (
  value: JsonRecord,
  policy: ModelContextFieldPolicy,
  presented: RuntimePresentedObservation | undefined,
): JSONValue => {
  const applied = value.applied;
  if (
    typeof value.searchId !== 'string' ||
    !Array.isArray(value.candidates) ||
    !isRecord(applied) ||
    typeof applied.areaDescription !== 'string' ||
    typeof applied.excludedCount !== 'number' ||
    (value.nextCursor !== null && typeof value.nextCursor !== 'string') ||
    value.coverage !== 'provider_results'
  ) {
    return MODEL_INPUT_WITHHELD;
  }
  const candidates = value.candidates.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.candidateId !== 'string') return undefined;
    return {
      candidateId: candidate.candidateId,
      identity: projectFieldResult(candidate.identity ?? null, 'identity', policy, presented),
      openingHours: projectFieldResult(
        candidate.openingHours ?? null,
        'opening_hours',
        policy,
        presented,
      ),
      price: projectFieldResult(candidate.price ?? null, 'price', policy, presented),
      facilities: projectFieldResult(candidate.facilities ?? null, 'facilities', policy, presented),
    };
  });
  if (candidates.some((candidate): candidate is undefined => candidate === undefined)) {
    return MODEL_INPUT_WITHHELD;
  }
  const safeCandidates = candidates.filter(
    (candidate): candidate is Exclude<(typeof candidates)[number], undefined> =>
      candidate !== undefined,
  );
  return {
    searchId: value.searchId,
    candidates: safeCandidates,
    applied: {
      areaDescription: applied.areaDescription,
      excludedCount: applied.excludedCount,
    },
    nextCursor: value.nextCursor,
    coverage: 'provider_results',
  };
};

const DETAIL_FIELDS: readonly DetailField[] = [
  'identity',
  'opening_hours',
  'price',
  'photos',
  'contact',
  'facilities',
];

const projectDetailsData = (
  value: JsonRecord,
  policy: ModelContextFieldPolicy,
  presented: RuntimePresentedObservation | undefined,
): JSONValue => {
  if (!Array.isArray(value.items)) return MODEL_INPUT_WITHHELD;
  const items = value.items.map((item) => {
    const fieldsValue = isRecord(item) ? item.fields : undefined;
    const candidateId = isRecord(item) ? item.candidateId : undefined;
    const candidateIdValue = typeof candidateId === 'string' ? candidateId : undefined;
    if (
      !isRecord(item) ||
      !isRecord(fieldsValue) ||
      candidateIdValue === undefined ||
      !v.safeParse(CandidateIdSchema, candidateIdValue).success
    ) {
      return undefined;
    }
    const fields: { [key: string]: JSONValue } = {};
    for (const field of DETAIL_FIELDS) {
      const fieldValue = fieldsValue[field];
      if (fieldValue !== undefined)
        fields[field] = projectFieldResult(fieldValue, field, policy, presented);
    }
    return { candidateId: candidateIdValue, fields };
  });
  return items.some((item): item is undefined => item === undefined)
    ? MODEL_INPUT_WITHHELD
    : {
        items: items.filter(
          (item): item is Exclude<(typeof items)[number], undefined> => item !== undefined,
        ),
      };
};

const projectIssueResult = (value: JsonRecord): JSONValue => ({
  status: 'error',
  error: safeIssue(value.error ?? null),
});

/** Strictly projects validated search/details/submit result shapes at the SDK model boundary. */
export const projectRuntimeToolResultForModel = (
  value: JSONValue,
  policy: ModelContextFieldPolicy,
  presented?: RuntimePresentedObservation,
): JSONValue => {
  if (!isRecord(value)) return MODEL_INPUT_WITHHELD;
  if (value.status === 'error') return projectIssueResult(value);
  if (value.status === 'ok' || value.status === 'partial') {
    const dataValue = value.data;
    if (!isRecord(dataValue)) return MODEL_INPUT_WITHHELD;
    const data = dataValue;
    const projected =
      Array.isArray(data.candidates) && 'searchId' in data
        ? projectSearchData(data, policy, presented)
        : Array.isArray(data.items)
          ? projectDetailsData(data, policy, presented)
          : MODEL_INPUT_WITHHELD;
    if (projected === MODEL_INPUT_WITHHELD) return projected;
    return {
      status: value.status,
      data: projected,
      warnings: Array.isArray(value.warnings)
        ? value.warnings.map((warning) => safeIssue(warning))
        : [],
    };
  }
  if (value.status === 'committed') {
    return {
      status: 'committed',
      responseId: typeof value.responseId === 'string' ? value.responseId : 'WITHHELD',
      revision: typeof value.revision === 'number' ? value.revision : 0,
      presentation: 'replace',
    };
  }
  if (value.status === 'invalid') {
    return {
      status: 'invalid',
      issues: Array.isArray(value.issues) ? value.issues.map((issue) => safeIssue(issue)) : [],
      repairable: value.repairable === true,
      remainingRepairs:
        typeof value.remainingRepairs === 'number' && Number.isSafeInteger(value.remainingRepairs)
          ? value.remainingRepairs
          : 0,
    };
  }
  return MODEL_INPUT_WITHHELD;
};
