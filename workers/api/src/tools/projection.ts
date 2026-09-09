import type {
  CandidateObservationRegistryPort,
  DetailField,
  FieldResult,
  GetPlaceDetailsOutput,
  HarnessContext,
  Issue,
  Observation,
  ReadonlyStoredObservation,
  Result,
  SearchPlacesOutput,
} from '@ima/core';
import { projectModelEvidence } from '@ima/core';
import type {
  DetailsToolResult,
  DetailsFieldValue,
  ModelSafeFieldResult,
  ModelSafeObservation,
  SafeGetPlaceDetailsOutput,
  SafePlaceFields,
  SafeSearchPlacesOutput,
  SearchToolResult,
} from './types';

type ProjectionRegistry = Pick<
  CandidateObservationRegistryPort,
  'readCandidate' | 'readObservation'
>;

const safePortIssue = (error: Issue): Issue => {
  return {
    code: error.code,
    path: error.path,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    message: 'tool result is unavailable',
    missingFields: [],
  };
};

const projectionIssue = (code: Issue['code'], path: string | null, message: string): Issue => ({
  code,
  path,
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [],
});

const unavailableField = <T>(
  status: 'unknown' | 'unsupported' | 'not_applicable' | 'withheld' | 'stale',
  reason?: string,
): ModelSafeFieldResult<T> => ({
  status,
  reason:
    reason ??
    (status === 'unknown'
      ? 'field value is unavailable'
      : status === 'unsupported'
        ? 'field is unsupported'
        : status === 'not_applicable'
          ? 'field does not apply'
          : 'evidence is unavailable for model input'),
});

const sameJsonValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
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

type SafeObservationDecision<T> =
  | { readonly status: 'known'; readonly observation: ModelSafeObservation<T> }
  | { readonly status: 'withheld' | 'stale'; readonly reason: string }
  | { readonly status: 'error'; readonly error: Issue };

const observationIssue = <T>(
  code: Issue['code'],
  path: string,
  message: string,
): SafeObservationDecision<T> => ({
  status: 'error',
  error: projectionIssue(code, path, message),
});

const safeObservation = <T>(
  observation: Observation<T>,
  expectedCandidateId: string,
  expectedField: DetailField,
  context: HarnessContext,
  registry: ProjectionRegistry,
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
    // Core owns the shared freshness/retention decision through projectModelEvidence.
    projected = projectModelEvidence(
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
      context.serverNow,
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

const candidateOwnershipIssue = (
  registry: ProjectionRegistry,
  context: HarnessContext,
  candidateIds: readonly string[],
  path: string,
): Issue | undefined => {
  const scope = { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId };
  for (const candidateId of candidateIds) {
    let candidate: ReturnType<ProjectionRegistry['readCandidate']>;
    try {
      candidate = registry.readCandidate(scope, candidateId);
    } catch {
      return projectionIssue('MISSING_CONTEXT', null, 'candidate registry is unavailable');
    }
    if (
      candidate === undefined ||
      candidate.candidateId !== candidateId ||
      candidate.ownerScopeRef !== scope.ownerScopeRef ||
      candidate.threadId !== scope.threadId
    ) {
      return projectionIssue('UNKNOWN_CANDIDATE', path, 'candidate is not owned by this thread');
    }
  }
  return undefined;
};

const projectFieldResult = <T>(
  result: FieldResult<T>,
  candidateId: string,
  expectedField: DetailField,
  context: HarnessContext,
  registry: ProjectionRegistry,
): ModelSafeFieldResult<T> => {
  if (result.status === 'error') {
    return { status: 'error', error: safePortIssue(result.error) };
  }
  if (result.status !== 'known') return unavailableField(result.status);

  const decisions = result.observations.map((observation) =>
    safeObservation(observation, candidateId, expectedField, context, registry),
  );
  const observations = decisions
    .filter(
      (
        decision,
      ): decision is { readonly status: 'known'; readonly observation: ModelSafeObservation<T> } =>
        decision.status === 'known',
    )
    .map((decision) => decision.observation);
  const error = decisions.find(
    (decision): decision is { readonly status: 'error'; readonly error: Issue } =>
      decision.status === 'error',
  );
  if (error !== undefined) return error;
  if (observations.length > 0) return { status: 'known', observations };
  const unavailable = decisions.find(
    (decision): decision is { readonly status: 'withheld' | 'stale'; readonly reason: string } =>
      decision.status === 'withheld' || decision.status === 'stale',
  );
  return unavailable === undefined
    ? unavailableField('unknown')
    : unavailableField(unavailable.status, unavailable.reason);
};

const projectSearchData = (
  data: SearchPlacesOutput,
  context: HarnessContext,
  registry: ProjectionRegistry,
): SafeSearchPlacesOutput => ({
  searchId: data.searchId,
  candidates: data.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    identity: projectFieldResult(
      candidate.identity,
      candidate.candidateId,
      'identity',
      context,
      registry,
    ),
    openingHours: projectFieldResult(
      candidate.openingHours,
      candidate.candidateId,
      'opening_hours',
      context,
      registry,
    ),
    price: projectFieldResult(candidate.price, candidate.candidateId, 'price', context, registry),
  })),
  applied: data.applied,
  nextCursor: data.nextCursor,
  coverage: data.coverage,
});

const projectDetailsFields = (
  fields: GetPlaceDetailsOutput['items'][number]['fields'],
  candidateId: string,
  context: HarnessContext,
  registry: ProjectionRegistry,
): SafePlaceFields => {
  const projected: {
    identity?: ModelSafeFieldResult<DetailsFieldValue<'identity'>>;
    opening_hours?: ModelSafeFieldResult<DetailsFieldValue<'opening_hours'>>;
    price?: ModelSafeFieldResult<DetailsFieldValue<'price'>>;
    photos?: ModelSafeFieldResult<DetailsFieldValue<'photos'>>;
    contact?: ModelSafeFieldResult<DetailsFieldValue<'contact'>>;
    facilities?: ModelSafeFieldResult<DetailsFieldValue<'facilities'>>;
    walking_route?: ModelSafeFieldResult<DetailsFieldValue<'walking_route'>>;
    last_train?: ModelSafeFieldResult<DetailsFieldValue<'last_train'>>;
  } = {};
  if (fields.identity !== undefined) {
    projected.identity = projectFieldResult(
      fields.identity,
      candidateId,
      'identity',
      context,
      registry,
    );
  }
  if (fields.opening_hours !== undefined) {
    projected.opening_hours = projectFieldResult(
      fields.opening_hours,
      candidateId,
      'opening_hours',
      context,
      registry,
    );
  }
  if (fields.price !== undefined) {
    projected.price = projectFieldResult(fields.price, candidateId, 'price', context, registry);
  }
  if (fields.photos !== undefined) {
    projected.photos = projectFieldResult(fields.photos, candidateId, 'photos', context, registry);
  }
  if (fields.contact !== undefined) {
    projected.contact = projectFieldResult(
      fields.contact,
      candidateId,
      'contact',
      context,
      registry,
    );
  }
  if (fields.facilities !== undefined) {
    projected.facilities = projectFieldResult(
      fields.facilities,
      candidateId,
      'facilities',
      context,
      registry,
    );
  }
  if (fields.walking_route !== undefined) {
    projected.walking_route = projectFieldResult(
      fields.walking_route,
      candidateId,
      'walking_route',
      context,
      registry,
    );
  }
  if (fields.last_train !== undefined) {
    projected.last_train = projectFieldResult(
      fields.last_train,
      candidateId,
      'last_train',
      context,
      registry,
    );
  }
  return projected;
};

const projectDetailsData = (
  data: GetPlaceDetailsOutput,
  context: HarnessContext,
  registry: ProjectionRegistry,
): SafeGetPlaceDetailsOutput => ({
  items: data.items.map((item) => ({
    candidateId: item.candidateId,
    fields: projectDetailsFields(item.fields, item.candidateId, context, registry),
  })),
});

export const projectSearchResult = (
  result: Result<SearchPlacesOutput>,
  context: HarnessContext,
  registry: ProjectionRegistry,
): SearchToolResult => {
  if (result.status === 'error') return { status: 'error', error: safePortIssue(result.error) };
  const ownershipIssue = candidateOwnershipIssue(
    registry,
    context,
    result.data.candidates.map((candidate) => candidate.candidateId),
    'result.candidates.candidateId',
  );
  if (ownershipIssue !== undefined) return { status: 'error', error: ownershipIssue };
  return {
    status: result.status,
    data: projectSearchData(result.data, context, registry),
    warnings: result.warnings.map(safePortIssue),
  };
};

export const projectDetailsResult = (
  result: Result<GetPlaceDetailsOutput>,
  context: HarnessContext,
  registry: ProjectionRegistry,
): DetailsToolResult => {
  if (result.status === 'error') return { status: 'error', error: safePortIssue(result.error) };
  const ownershipIssue = candidateOwnershipIssue(
    registry,
    context,
    result.data.items.map((item) => item.candidateId),
    'result.items.candidateId',
  );
  if (ownershipIssue !== undefined) return { status: 'error', error: ownershipIssue };
  return {
    status: result.status,
    data: projectDetailsData(result.data, context, registry),
    warnings: result.warnings.map(safePortIssue),
  };
};
