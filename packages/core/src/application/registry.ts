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
  CandidateRegistrationSchema,
  RegistryError,
  type CandidateRecord,
  type CandidateRegistration,
  type ObservationRegistration,
  type ObservationReuseQuery,
  type ObservationReuseResult,
  type ReadonlyStoredObservation,
  type RegistryJsonValue,
  type StoredObservation,
} from '../domain/registry';
import { RetentionMetadataSchema } from '../domain/retention';
import {
  CandidateIdSchema,
  IsoTimestampSchema,
  OpaqueIdSchema,
  type CandidateId,
} from '../domain/primitives';
import type { CandidateObservationRegistryPort } from '../ports/registry';
import type { ClockPort, RegistryIdPort } from '../ports/context';

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

function valueKey(value: RegistryJsonValue): string {
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

function identityKey(ownerScopeRef: string, provider: string, recordRef: string): string {
  return JSON.stringify([ownerScopeRef, provider, recordRef]);
}

function candidateKey(
  ownerScopeRef: string,
  threadId: string,
  provider: string,
  recordRef: string,
): string {
  return JSON.stringify([ownerScopeRef, threadId, provider, recordRef]);
}

function reuseKey(scope: RegistryScope, candidateId: CandidateId, field: string): string {
  return JSON.stringify([scope.ownerScopeRef, scope.threadId, candidateId, field]);
}

function assertScope(scope: RegistryScope): void {
  if (!v.safeParse(RegistryScopeSchema, scope).success) {
    throw new RegistryError('INVALID_ARGUMENT', 'registry scope is invalid');
  }
}

function assertOpaqueId(id: string, used: ReadonlySet<string>, kind: string): string {
  if (!v.safeParse(OpaqueIdSchema, id).success) {
    throw new RegistryError('INVALID_ID', `${kind} generator returned an invalid ID`);
  }
  if (used.has(id))
    throw new RegistryError('DUPLICATE_ID', `${kind} generator returned a duplicate ID`);
  return id;
}

function assertCandidateId(id: string, used: ReadonlySet<CandidateId>): CandidateId {
  const parsed = v.safeParse(CandidateIdSchema, id);
  if (!parsed.success)
    throw new RegistryError('INVALID_ID', 'candidateId generator returned an invalid ID');
  if (used.has(parsed.output))
    throw new RegistryError('DUPLICATE_ID', 'candidateId generator returned a duplicate ID');
  return parsed.output;
}

function scopeError(
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

export class CandidateObservationRegistry implements CandidateObservationRegistryPort {
  private readonly placeRefs = new Map<string, string>();
  private readonly candidateIdsByKey = new Map<string, CandidateId>();
  private readonly candidates = new Map<CandidateId, Readonly<CandidateRecord>>();
  private readonly observations = new Map<string, ReadonlyStoredObservation>();
  private readonly observationIdsByCandidate = new Map<CandidateId, string[]>();
  private readonly blockedReuse = new Map<string, ReadonlySet<string>>();
  private readonly suppressedReuse = new Map<string, Set<string>>();

  constructor(
    private readonly clock: ClockPort,
    private readonly ids: RegistryIdPort,
  ) {
    this.now();
  }

  registerCandidate(input: CandidateRegistration): Readonly<CandidateRecord> {
    const parsed = v.safeParse(CandidateRegistrationSchema, input);
    if (!parsed.success)
      throw new RegistryError('INVALID_ARGUMENT', 'candidate registration is invalid');
    const candidate = parsed.output;
    const key = candidateKey(
      candidate.ownerScopeRef,
      candidate.threadId,
      candidate.provider,
      candidate.recordRef,
    );
    const existingId = this.candidateIdsByKey.get(key);
    if (existingId !== undefined) {
      const existing = this.candidates.get(existingId);
      if (existing === undefined)
        throw new RegistryError('UNKNOWN_CANDIDATE', 'candidate index is inconsistent');
      const updated = Object.freeze({
        ...existing,
        displayName: candidate.displayName,
        status: candidate.status,
      });
      this.candidates.set(existingId, updated);
      return updated;
    }

    const placeKey = identityKey(candidate.ownerScopeRef, candidate.provider, candidate.recordRef);
    let placeRef = this.placeRefs.get(placeKey);
    if (placeRef === undefined) {
      placeRef = assertOpaqueId(
        this.ids.nextPlaceRef(),
        new Set(this.placeRefs.values()),
        'placeRef',
      );
    }
    const candidateId = assertCandidateId(
      this.ids.nextCandidateId(),
      new Set(this.candidates.keys()),
    );
    const record = Object.freeze({ ...candidate, candidateId, placeRef, excluded: false });
    if (!this.placeRefs.has(placeKey)) this.placeRefs.set(placeKey, placeRef);
    this.candidateIdsByKey.set(key, candidateId);
    this.candidates.set(candidateId, record);
    return record;
  }

  importCandidate(
    sourceScope: RegistryScope,
    targetScope: RegistryScope,
    candidateId: CandidateId,
    details: Pick<CandidateRegistration, 'displayName' | 'status'>,
  ): Readonly<CandidateRecord> | undefined {
    assertScope(sourceScope);
    assertScope(targetScope);
    const source = this.readCandidate(sourceScope, candidateId);
    if (source === undefined || source.ownerScopeRef !== targetScope.ownerScopeRef) {
      return undefined;
    }
    if (sourceScope.threadId === targetScope.threadId) {
      throw new RegistryError(
        'INVALID_ARGUMENT',
        'candidate import target must be a different thread',
      );
    }
    if (typeof details !== 'object' || details === null) {
      throw new RegistryError('INVALID_ARGUMENT', 'candidate import details are invalid');
    }
    return this.registerCandidate({
      ...targetScope,
      provider: source.provider,
      recordRef: source.recordRef,
      displayName: details.displayName,
      status: details.status,
    });
  }

  readCandidate(
    scope: RegistryScope,
    candidateId: CandidateId,
  ): Readonly<CandidateRecord> | undefined {
    assertScope(scope);
    const candidate = this.candidates.get(candidateId);
    if (candidate === undefined || scopeError(scope, candidate) !== undefined) return undefined;
    return candidate;
  }

  listCandidates(scope: RegistryScope): readonly Readonly<CandidateRecord>[] {
    assertScope(scope);
    return [...this.candidates.values()].filter(
      (candidate) =>
        candidate.ownerScopeRef === scope.ownerScopeRef && candidate.threadId === scope.threadId,
    );
  }

  excludeCandidate(scope: RegistryScope, candidateId: CandidateId): Readonly<CandidateRecord> {
    const candidate = this.requireCandidate(scope, candidateId);
    const excluded = Object.freeze({ ...candidate, excluded: true });
    this.candidates.set(candidateId, excluded);
    return excluded;
  }

  registerObservation(input: ObservationRegistration): Readonly<StoredObservation> {
    assertScope(input.scope);
    const candidate = this.candidates.get(input.candidateId);
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
    // A null policy freshUntil carries no finite provider bound; the required local freshUntil
    // still governs reuse, so null never turns an observation into an indefinitely fresh value.
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
    const fetchedAt = this.now();
    const observationId = assertOpaqueId(
      this.ids.nextObservationId(),
      new Set(this.observations.keys()),
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
        attribution:
          input.retention.attribution === null ? null : { ...input.retention.attribution },
      },
    };
    const parsed = v.safeParse(AnyObservationSchema, observation);
    if (!parsed.success || Date.parse(input.freshUntil) > Date.parse(input.expiresAt)) {
      throw new RegistryError(
        'INVALID_OBSERVATION',
        'observation timestamps or fields are invalid',
      );
    }
    freezeDeep(observation);
    const stored: ReadonlyStoredObservation = Object.freeze(observation);
    this.observations.set(observationId, stored);
    const ids = this.observationIdsByCandidate.get(input.candidateId) ?? [];
    ids.push(observationId);
    this.observationIdsByCandidate.set(input.candidateId, ids);
    return stored;
  }

  readObservation(
    scope: RegistryScope,
    observationId: string,
  ): ReadonlyStoredObservation | undefined {
    assertScope(scope);
    const observation = this.observations.get(observationId);
    if (observation === undefined) return undefined;
    return this.readCandidate(scope, observation.candidateId) === undefined
      ? undefined
      : observation;
  }

  listObservations(
    scope: RegistryScope,
    candidateId?: CandidateId,
  ): readonly ReadonlyStoredObservation[] {
    assertScope(scope);
    const ids =
      candidateId === undefined
        ? [...this.observations.keys()]
        : [...(this.observationIdsByCandidate.get(candidateId) ?? [])];
    const result: ReadonlyStoredObservation[] = [];
    for (const observationId of ids) {
      const observation = this.readObservation(scope, observationId);
      if (observation !== undefined) result.push(observation);
    }
    return result;
  }

  invalidateObservationReuse(scope: RegistryScope, candidateId: CandidateId, field: string): void {
    this.requireCandidate(scope, candidateId);
    const key = reuseKey(scope, candidateId, field);
    const suppressed = this.suppressedReuse.get(key);
    const activeIds = this.listObservations(scope, candidateId)
      .filter(
        (observation) =>
          observation.field === field && !(suppressed?.has(observation.observationId) ?? false),
      )
      .map((observation) => observation.observationId);
    this.blockedReuse.set(key, new Set(activeIds));
  }

  restoreObservationReuse(
    scope: RegistryScope,
    candidateId: CandidateId,
    field: string,
    observationIds: readonly string[],
  ): boolean {
    this.requireCandidate(scope, candidateId);
    const key = reuseKey(scope, candidateId, field);
    const blocked = this.blockedReuse.get(key);
    if (blocked === undefined) return true;
    const suppressed = this.suppressedReuse.get(key);
    const hasNewObservation = observationIds.some((observationId) => {
      if (blocked.has(observationId) || (suppressed?.has(observationId) ?? false)) return false;
      const observation = this.readObservation(scope, observationId);
      return observation?.candidateId === candidateId && observation.field === field;
    });
    if (!hasNewObservation) return false;

    const nextSuppressed = suppressed ?? new Set<string>();
    for (const observationId of blocked) nextSuppressed.add(observationId);
    this.suppressedReuse.set(key, nextSuppressed);
    this.blockedReuse.delete(key);
    return true;
  }

  evaluateObservationReuse(query: ObservationReuseQuery): ObservationReuseResult {
    assertScope(query.scope);
    if (
      query.context.ownerScopeRef !== query.scope.ownerScopeRef ||
      query.context.threadId !== query.scope.threadId
    ) {
      return { status: 'context_mismatch' };
    }
    const candidate = this.candidates.get(query.candidateId);
    if (candidate === undefined) return { status: 'missing' };
    if (scopeError(query.scope, candidate) !== undefined) return { status: 'context_mismatch' };
    const key = reuseKey(query.scope, query.candidateId, query.field);
    if (this.blockedReuse.has(key)) return { status: 'missing' };
    const suppressed = this.suppressedReuse.get(key);
    const observations = this.listObservations(query.scope, query.candidateId).filter(
      (observation) =>
        observation.field === query.field && !(suppressed?.has(observation.observationId) ?? false),
    );
    if (
      query.observationId !== undefined &&
      !observations.some((observation) => observation.observationId === query.observationId)
    ) {
      return { status: 'missing' };
    }
    if (observations.length === 0) return { status: 'missing' };
    const contextKey = contextKeyForObservation(query.context, query.field);
    const matching = observations.filter(
      (observation) =>
        observation.contextKey === contextKey &&
        matchesObservationContext(observation.context, query.context),
    );
    if (matching.length === 0) return { status: 'context_mismatch' };
    const now = this.now();
    const fresh = matching.filter(
      (observation) => observationFreshness(observation, now) === 'fresh',
    );
    if (fresh.length === 0) return { status: 'expired' };
    const distinctValues = new Set(fresh.map((observation) => valueKey(observation.value)));
    if (distinctValues.size > 1) return { status: 'conflict', observations: fresh };
    if (query.observationId !== undefined) {
      const requested = fresh.find(
        (observation) => observation.observationId === query.observationId,
      );
      if (requested === undefined) return { status: 'expired' };
      return { status: 'reusable', observation: requested };
    }
    const selected = [...fresh].sort((left, right) => {
      const time = Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt);
      return time === 0 ? right.observationId.localeCompare(left.observationId) : time;
    })[0];
    if (selected === undefined) return { status: 'missing' };
    return { status: 'reusable', observation: selected };
  }

  findReusableObservation(query: ObservationReuseQuery): ReadonlyStoredObservation | undefined {
    const result = this.evaluateObservationReuse(query);
    return result.status === 'reusable' ? result.observation : undefined;
  }

  private requireCandidate(
    scope: RegistryScope,
    candidateId: CandidateId,
  ): Readonly<CandidateRecord> {
    assertScope(scope);
    const candidate = this.candidates.get(candidateId);
    if (candidate === undefined)
      throw new RegistryError('UNKNOWN_CANDIDATE', 'candidate is not registered');
    const accessError = scopeError(scope, candidate);
    if (accessError !== undefined) throw accessError;
    return candidate;
  }

  private now(): string {
    const value = this.clock.now();
    const parsed = v.safeParse(IsoTimestampSchema, value);
    if (!parsed.success)
      throw new RegistryError('INVALID_CLOCK', 'clock returned an invalid timestamp');
    return parsed.output;
  }
}
