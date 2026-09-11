import * as v from 'valibot';
import { AnyObservationSchema } from '../domain/evidence';
import {
  contextKeyForObservation,
  matchesObservationContext,
  observationFreshness,
  ObservationContextSchema,
  RegistryScopeSchema,
  type RegistryScope,
} from '../domain/freshness';
import {
  RegistryError,
  type CandidateRecord,
  type ObservationRegistration,
  type ReadonlyStoredObservation,
  type RegistryJsonValue,
  type StoredObservation,
} from '../domain/registry';
import { RetentionMetadataSchema } from '../domain/retention';
import { IsoTimestampSchema, OpaqueIdSchema, type CandidateId } from '../domain/primitives';

export type ObservationPreparationDependencies = {
  readonly candidateFor: (candidateId: CandidateId) => Readonly<CandidateRecord> | undefined;
  readonly now: () => string;
  readonly nextObservationId: () => string;
  readonly existingObservationIds: ReadonlySet<string>;
};

export type ObservationReplacementDependencies = {
  readonly candidateFor: (candidateId: CandidateId) => Readonly<CandidateRecord> | undefined;
  readonly observationFor: (observationId: string) => ReadonlyStoredObservation | undefined;
  readonly observationsFor: (
    scope: RegistryScope,
    candidateId: CandidateId,
  ) => readonly ReadonlyStoredObservation[];
  readonly blockedFor: (key: string) => ReadonlySet<string> | undefined;
  readonly suppressedFor: (key: string) => ReadonlySet<string> | undefined;
  readonly keyFor: (scope: RegistryScope, candidateId: CandidateId, field: string) => string;
  readonly now: () => string;
};

export function assertScope(scope: RegistryScope): void {
  if (!v.safeParse(RegistryScopeSchema, scope).success) {
    throw new RegistryError('INVALID_ARGUMENT', 'registry scope is invalid');
  }
}

export function assertOpaqueId(id: string, used: ReadonlySet<string>, kind: string): string {
  if (!v.safeParse(OpaqueIdSchema, id).success) {
    throw new RegistryError('INVALID_ID', `${kind} generator returned an invalid ID`);
  }
  if (used.has(id))
    throw new RegistryError('DUPLICATE_ID', `${kind} generator returned a duplicate ID`);
  return id;
}

export function scopeError(
  expected: RegistryScope,
  actual: Pick<CandidateRecord, 'ownerScopeRef' | 'threadId'>,
): RegistryError | undefined {
  if (expected.ownerScopeRef !== actual.ownerScopeRef) {
    return new RegistryError('OWNER_SCOPE_MISMATCH', 'registry owner scope does not match');
  }
  if (expected.threadId !== actual.threadId) {
    return new RegistryError('THREAD_SCOPE_MISMATCH', 'registry thread scope does not match');
  }
  return undefined;
}

function cloneJsonValue(value: unknown, stack = new Set<object>()): RegistryJsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || stack.has(value)) return undefined;
  stack.add(value);
  if (Array.isArray(value)) {
    const result: RegistryJsonValue[] = [];
    for (const item of value) {
      const cloned = cloneJsonValue(item, stack);
      if (cloned === undefined) return undefined;
      result.push(cloned);
    }
    stack.delete(value);
    return result;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const result: { [key: string]: RegistryJsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    const cloned = cloneJsonValue(item, stack);
    if (cloned === undefined) return undefined;
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: cloned,
      writable: true,
    });
  }
  stack.delete(value);
  return result;
}

function freezeDeep(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  Object.freeze(value);
}

export function valueKey(value: RegistryJsonValue): string {
  const normalized = (input: RegistryJsonValue): RegistryJsonValue => {
    if (Array.isArray(input)) return input.map(normalized);
    if (input === null || typeof input !== 'object') return input;
    const result: { [key: string]: RegistryJsonValue } = {};
    for (const [key, nested] of Object.entries(input).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: normalized(nested),
        writable: true,
      });
    }
    return result;
  };
  return JSON.stringify(normalized(value)) ?? '';
}

export function prepareObservation(
  input: ObservationRegistration,
  dependencies: ObservationPreparationDependencies,
): ReadonlyStoredObservation {
  assertScope(input.scope);
  const candidate = dependencies.candidateFor(input.candidateId);
  if (candidate === undefined)
    throw new RegistryError('UNKNOWN_CANDIDATE', 'candidate is not registered');
  const accessError = scopeError(input.scope, candidate);
  if (accessError !== undefined) throw accessError;
  if (
    input.context.ownerScopeRef !== input.scope.ownerScopeRef ||
    input.context.threadId !== input.scope.threadId
  ) {
    throw new RegistryError('THREAD_SCOPE_MISMATCH', 'observation context does not match scope');
  }
  if (!v.safeParse(ObservationContextSchema, input.context).success) {
    throw new RegistryError('INVALID_ARGUMENT', 'observation context is invalid');
  }
  if (
    !v.safeParse(IsoTimestampSchema, input.freshUntil).success ||
    !v.safeParse(IsoTimestampSchema, input.expiresAt).success ||
    !v.safeParse(RetentionMetadataSchema, input.retention).success
  ) {
    throw new RegistryError(
      'INVALID_OBSERVATION',
      'observation timestamps or retention are invalid',
    );
  }
  // A null policy freshUntil carries no finite provider bound; local freshness still governs reuse.
  if (
    input.retention.freshUntil !== null &&
    Date.parse(input.freshUntil) > Date.parse(input.retention.freshUntil)
  ) {
    throw new RegistryError(
      'INVALID_OBSERVATION',
      'observation freshness exceeds the retention freshness bound',
    );
  }
  const value = cloneJsonValue(input.value);
  if (value === undefined)
    throw new RegistryError('INVALID_OBSERVATION', 'observation value must be JSON data');
  const fetchedAt = dependencies.now();
  const observationId = assertOpaqueId(
    dependencies.nextObservationId(),
    dependencies.existingObservationIds,
    'observationId',
  );
  const observation: StoredObservation = {
    observationId,
    candidateId: input.candidateId,
    field: input.field,
    value,
    basis: input.basis,
    fetchedAt,
    sourceUpdatedAt: input.sourceUpdatedAt,
    expiresAt: input.expiresAt,
    freshUntil: input.freshUntil,
    contextKey: contextKeyForObservation(input.context, input.field),
    context: { ...input.context },
    sources: input.sources.map((source) => ({ ...source })),
    retention: {
      ...input.retention,
      attribution: input.retention.attribution === null ? null : { ...input.retention.attribution },
    },
  };
  const parsed = v.safeParse(AnyObservationSchema, observation);
  if (!parsed.success || Date.parse(input.freshUntil) > Date.parse(input.expiresAt)) {
    throw new RegistryError('INVALID_OBSERVATION', 'observation timestamps or fields are invalid');
  }
  freezeDeep(observation);
  return Object.freeze(observation);
}

export function validateReplacement(
  registration: ObservationRegistration,
  expectedObservationId: string,
  dependencies: ObservationReplacementDependencies,
): { readonly key: string; readonly observationIds: readonly string[] } {
  assertScope(registration.scope);
  const candidate = dependencies.candidateFor(registration.candidateId);
  if (candidate === undefined)
    throw new RegistryError('UNKNOWN_CANDIDATE', 'candidate is not registered');
  const accessError = scopeError(registration.scope, candidate);
  if (accessError !== undefined) throw accessError;
  if (
    registration.context.ownerScopeRef !== registration.scope.ownerScopeRef ||
    registration.context.threadId !== registration.scope.threadId
  ) {
    throw new RegistryError('THREAD_SCOPE_MISMATCH', 'observation context does not match scope');
  }
  if (
    typeof registration.field !== 'string' ||
    !v.safeParse(ObservationContextSchema, registration.context).success
  ) {
    throw new RegistryError('INVALID_ARGUMENT', 'observation replacement registration is invalid');
  }
  if (
    typeof expectedObservationId !== 'string' ||
    !v.safeParse(OpaqueIdSchema, expectedObservationId).success
  ) {
    throw new RegistryError(
      'INVALID_ARGUMENT',
      'observation replacement must name an existing observation',
    );
  }
  const key = dependencies.keyFor(registration.scope, registration.candidateId, registration.field);
  const blocked = dependencies.blockedFor(key);
  if (blocked !== undefined) {
    throw new RegistryError(
      'INVALID_OBSERVATION',
      'observation replacement cannot use a blocked reuse set',
    );
  }
  const suppressed = dependencies.suppressedFor(key);
  const expected = dependencies.observationFor(expectedObservationId);
  if (expected === undefined) {
    throw new RegistryError('INVALID_OBSERVATION', 'replacement observation is not registered');
  }
  const expectedCandidate = dependencies.candidateFor(expected.candidateId);
  if (expectedCandidate === undefined) {
    throw new RegistryError('UNKNOWN_CANDIDATE', 'replacement candidate is not registered');
  }
  const expectedAccessError = scopeError(registration.scope, expectedCandidate);
  if (expectedAccessError !== undefined) throw expectedAccessError;
  if (
    expected.candidateId !== registration.candidateId ||
    expected.field !== registration.field ||
    !matchesObservationContext(expected.context, registration.context) ||
    suppressed?.has(expectedObservationId) === true
  ) {
    throw new RegistryError(
      'INVALID_OBSERVATION',
      'replacement observation does not match the registration',
    );
  }
  const active = dependencies
    .observationsFor(registration.scope, registration.candidateId)
    .filter(
      (observation) =>
        observation.field === registration.field &&
        matchesObservationContext(observation.context, registration.context) &&
        suppressed?.has(observation.observationId) !== true,
    );
  if (!active.some((observation) => observation.observationId === expectedObservationId)) {
    throw new RegistryError(
      'INVALID_OBSERVATION',
      'replacement observation is stale or suppressed',
    );
  }
  const now = dependencies.now();
  if (observationFreshness(expected, now) !== 'fresh') {
    throw new RegistryError('INVALID_OBSERVATION', 'replacement observation is no longer fresh');
  }
  const expectedValue = valueKey(expected.value);
  const hasConflict = active.some(
    (observation) =>
      observationFreshness(observation, now) === 'fresh' &&
      valueKey(observation.value) !== expectedValue,
  );
  if (hasConflict) {
    throw new RegistryError(
      'INVALID_OBSERVATION',
      'replacement cannot hide conflicting fresh observations',
    );
  }
  return { key, observationIds: active.map((observation) => observation.observationId) };
}
