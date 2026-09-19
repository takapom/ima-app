import * as v from 'valibot';
import {
  denyModelContextFieldPolicy,
  modelContextFieldAllowed,
  modelEvidenceFieldDecision,
  type ModelContextFieldPolicy,
} from '@worker/application/model-context/model-context-policy';
import { projectModelEvidenceForLlmInput } from '@worker/application/model-context/model-evidence';
import { type CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import { type DetailField } from '@worker/domain/primitives';
import { type HarnessContext } from '@worker/application/ports/context';
import { type Issue } from '@worker/domain/issue';
import { type Observation } from '@worker/domain/evidence/evidence';
import { type ReadonlyStoredObservation } from '@worker/domain/candidates/registry';
import {
  ContactInfoSchema,
  FacilitiesInfoSchema,
  LastTrainInfoSchema,
  OpeningHoursSchema,
  PhotoInfoSchema,
  PlaceIdentitySchema,
  PriceInfoSchema,
  WalkingRouteSchema,
} from '@worker/domain/places/place-values';
import type { ModelSafeObservation } from '@worker/runtime/ports/tool-binding';

export type ProjectionRegistry = Pick<
  CandidateObservationRegistryPort,
  'readCandidate' | 'readObservation'
>;

export type SafeObservationDecision<T> =
  | { readonly status: 'known'; readonly observation: ModelSafeObservation<T> }
  | { readonly status: 'withheld' | 'stale'; readonly reason: string }
  | { readonly status: 'error'; readonly error: Issue };

const projectionIssue = (code: Issue['code'], path: string | null, message: string): Issue => ({
  code,
  path,
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [],
});

const sameJsonValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);
    return (
      leftDescriptor !== undefined &&
      rightDescriptor !== undefined &&
      'value' in leftDescriptor &&
      'value' in rightDescriptor &&
      sameJsonValue(leftDescriptor.value, rightDescriptor.value)
    );
  });
};

const observationIssue = <T>(
  code: Issue['code'],
  path: string,
  message: string,
): SafeObservationDecision<T> => ({
  status: 'error',
  error: projectionIssue(code, path, message),
});

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

export const safeObservation = <T>(
  observation: Observation<T>,
  expectedCandidateId: string,
  expectedField: DetailField,
  context: HarnessContext,
  registry: ProjectionRegistry,
  now: string,
  fieldPolicy: ModelContextFieldPolicy | undefined,
): SafeObservationDecision<T> => {
  if (observation.candidateId !== expectedCandidateId || observation.field !== expectedField) {
    return observationIssue(
      'INVALID_EVIDENCE',
      'observations',
      'observation identity does not match its candidate field',
    );
  }
  if (observation.context === undefined) {
    return observationIssue(
      'MISSING_CONTEXT',
      'observations.context',
      'observation context is missing',
    );
  }
  if (
    observation.context.ownerScopeRef !== context.ownerScopeRef ||
    observation.context.threadId !== context.threadId
  ) {
    return observationIssue(
      'INVALID_EVIDENCE',
      'observations.context',
      'observation context does not match this thread',
    );
  }
  const scope = { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId };
  let stored: ReadonlyStoredObservation | undefined;
  try {
    stored = registry.readObservation(scope, observation.observationId);
  } catch {
    return observationIssue(
      'MISSING_CONTEXT',
      'observations',
      'observation registry is unavailable',
    );
  }
  if (stored === undefined) {
    return observationIssue(
      'MISSING_EVIDENCE',
      'observations.observationId',
      'observation is not registered',
    );
  }
  if (
    stored.candidateId !== expectedCandidateId ||
    stored.field !== expectedField ||
    stored.context.ownerScopeRef !== context.ownerScopeRef ||
    stored.context.threadId !== context.threadId
  ) {
    return observationIssue(
      'INVALID_EVIDENCE',
      'observations',
      'registered observation does not match its candidate field or thread',
    );
  }
  let projected;
  try {
    projected = projectModelEvidenceForLlmInput(
      {
        ownerScopeRef: stored.context.ownerScopeRef,
        threadId: stored.context.threadId,
        observationId: stored.observationId,
        candidateId: stored.candidateId,
        field: stored.field,
        value: stored.value,
        fetchedAt: stored.fetchedAt,
        freshUntil: stored.freshUntil,
        expiresAt: stored.expiresAt,
        sources: stored.sources,
        retention: stored.retention,
      },
      now,
    );
  } catch {
    return observationIssue(
      'INVALID_EVIDENCE',
      'observations',
      'registered observation is invalid',
    );
  }
  if (projected.status !== 'known') {
    return { status: projected.status, reason: projected.reason };
  }
  const effectiveFieldPolicy = fieldPolicy ?? denyModelContextFieldPolicy;
  if (!modelContextFieldAllowed(modelEvidenceFieldDecision(effectiveFieldPolicy, expectedField))) {
    return { status: 'withheld', reason: 'evidence policy does not allow model input' };
  }
  if (!v.safeParse(schemaForField(expectedField), observation.value).success) {
    return observationIssue(
      'INVALID_EVIDENCE',
      'observations.value',
      'observation value is invalid',
    );
  }
  let valueMatches = false;
  try {
    valueMatches = sameJsonValue(projected.value, observation.value);
  } catch {
    return observationIssue(
      'INVALID_EVIDENCE',
      'observations.value',
      'observation value is invalid',
    );
  }
  if (!valueMatches) {
    return observationIssue(
      'INVALID_EVIDENCE',
      'observations.value',
      'observation value does not match the registry snapshot',
    );
  }
  return {
    status: 'known',
    observation: {
      observationId: stored.observationId,
      candidateId: stored.candidateId,
      field: expectedField,
      value: structuredClone(observation.value),
      basis: stored.basis,
      fetchedAt: stored.fetchedAt,
      sourceUpdatedAt: stored.sourceUpdatedAt,
      expiresAt: stored.expiresAt,
      freshUntil: projected.freshUntil,
      sources: stored.sources.map((source) => ({
        provider: source.provider,
        attribution: source.attribution,
        publicUrl: source.publicUrl,
      })),
    },
  };
};
