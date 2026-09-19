import type { DetailField } from '@worker/domain/primitives';
import type { FieldResult, Result } from '@worker/domain/result';
import type {
  GetPlaceDetailsOutput,
  SearchPlacesOutput,
} from '@worker/application/ports/operations';
import type { HarnessContext } from '@worker/application/ports/context';
import type { Issue } from '@worker/domain/issue';
import type { ModelContextFieldPolicy } from '@worker/application/model-context/model-context-policy';
import type {
  DetailsFieldValue,
  DetailsToolResult,
  ModelSafeFieldResult,
  ModelSafeObservation,
  SafeDetailsTarget,
  SafeGetPlaceDetailsOutput,
  SafePlaceFields,
  SafeSearchPlacesOutput,
  SearchToolResult,
} from '@worker/runtime/ports/tool-binding';
import {
  safeObservation,
  type ProjectionRegistry,
} from '@worker/adapters/in/tools/projection-evidence';

const safePortIssue = (error: Issue): Issue => ({
  code: error.code,
  path: error.path,
  retryable: error.retryable,
  retryAfterMs: error.retryAfterMs,
  message: 'tool result is unavailable',
  missingFields: [],
});

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
  now: string,
  fieldPolicy: ModelContextFieldPolicy | undefined,
): ModelSafeFieldResult<T> => {
  if (result.status === 'error') return { status: 'error', error: safePortIssue(result.error) };
  if (result.status !== 'known') return unavailableField(result.status);

  const decisions = result.observations.map((observation) =>
    safeObservation(observation, candidateId, expectedField, context, registry, now, fieldPolicy),
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
  now: string,
  fieldPolicy: ModelContextFieldPolicy | undefined,
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
      now,
      fieldPolicy,
    ),
    openingHours: projectFieldResult(
      candidate.openingHours,
      candidate.candidateId,
      'opening_hours',
      context,
      registry,
      now,
      fieldPolicy,
    ),
    price: projectFieldResult(
      candidate.price,
      candidate.candidateId,
      'price',
      context,
      registry,
      now,
      fieldPolicy,
    ),
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
  now: string,
  fieldPolicy: ModelContextFieldPolicy | undefined,
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
  const project = <T>(result: FieldResult<T>, field: DetailField): ModelSafeFieldResult<T> =>
    projectFieldResult(result, candidateId, field, context, registry, now, fieldPolicy);
  if (fields.identity !== undefined) projected.identity = project(fields.identity, 'identity');
  if (fields.opening_hours !== undefined) {
    projected.opening_hours = project(fields.opening_hours, 'opening_hours');
  }
  if (fields.price !== undefined) projected.price = project(fields.price, 'price');
  if (fields.photos !== undefined) projected.photos = project(fields.photos, 'photos');
  if (fields.contact !== undefined) projected.contact = project(fields.contact, 'contact');
  if (fields.facilities !== undefined) {
    projected.facilities = project(fields.facilities, 'facilities');
  }
  if (fields.walking_route !== undefined) {
    projected.walking_route = project(fields.walking_route, 'walking_route');
  }
  if (fields.last_train !== undefined) {
    projected.last_train = project(fields.last_train, 'last_train');
  }
  return projected;
};

const projectDetailsData = (
  data: GetPlaceDetailsOutput,
  context: HarnessContext,
  registry: ProjectionRegistry,
  now: string,
  fieldPolicy: ModelContextFieldPolicy | undefined,
  targetForCandidate: (candidateId: string) => SafeDetailsTarget = (candidateId) => ({
    candidateId,
  }),
): SafeGetPlaceDetailsOutput => ({
  items: data.items.map((item) => ({
    ...targetForCandidate(item.candidateId),
    fields: projectDetailsFields(
      item.fields,
      item.candidateId,
      context,
      registry,
      now,
      fieldPolicy,
    ),
  })),
});

export const projectSearchResult = (
  result: Result<SearchPlacesOutput>,
  context: HarnessContext,
  registry: ProjectionRegistry,
  now: string,
  fieldPolicy?: ModelContextFieldPolicy,
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
    data: projectSearchData(result.data, context, registry, now, fieldPolicy),
    warnings: result.warnings.map(safePortIssue),
  };
};

export const projectDetailsResult = (
  result: Result<GetPlaceDetailsOutput>,
  context: HarnessContext,
  registry: ProjectionRegistry,
  now: string,
  fieldPolicy?: ModelContextFieldPolicy,
  targetForCandidate?: (candidateId: string) => SafeDetailsTarget,
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
    data: projectDetailsData(result.data, context, registry, now, fieldPolicy, targetForCandidate),
    warnings: result.warnings.map(safePortIssue),
  };
};
