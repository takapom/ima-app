import * as v from 'valibot';
import {
  contextKeyForObservation,
  matchesObservationContext,
  observationFreshness,
  type RegistryScope,
} from '../../domain/freshness';
import {
  CandidateRegistrationSchema,
  RegistryError,
  type CandidateRecord,
  type CandidateRegistration,
  type ObservationRegistration,
  type ObservationReuseQuery,
  type ObservationReuseResult,
  type ReadonlyStoredObservation,
  type StoredObservation,
} from '../../domain/registry';
import { CandidateIdSchema, IsoTimestampSchema, type CandidateId } from '../../domain/primitives';
import type {
  CandidateObservationRegistryPort,
  ObservationReplacement,
} from '../../ports/registry';
import type { ClockPort, RegistryIdPort } from '../../ports/context';
import {
  assertOpaqueId,
  assertScope,
  prepareObservation as prepareStoredObservation,
  scopeError,
  validateReplacement as validateObservationReplacement,
  valueKey,
} from './registry-observation';

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

function assertCandidateId(id: string, used: ReadonlySet<CandidateId>): CandidateId {
  const parsed = v.safeParse(CandidateIdSchema, id);
  if (!parsed.success)
    throw new RegistryError('INVALID_ID', 'candidateId generator returned an invalid ID');
  if (used.has(parsed.output))
    throw new RegistryError('DUPLICATE_ID', 'candidateId generator returned a duplicate ID');
  return parsed.output;
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
    const stored = this.prepareObservation(input);
    this.storeObservation(stored);
    return stored;
  }

  replaceObservation(input: ObservationReplacement): ReadonlyStoredObservation {
    const { registration, expectedObservationId } = input;
    const { key, observationIds } = this.validateReplacement(registration, expectedObservationId);
    const stored = this.prepareObservation(registration);
    this.storeObservation(stored);
    const suppressed = new Set(this.suppressedReuse.get(key) ?? []);
    for (const observationId of observationIds) suppressed.add(observationId);
    this.suppressedReuse.set(key, suppressed);
    return stored;
  }

  private prepareObservation(input: ObservationRegistration): ReadonlyStoredObservation {
    return prepareStoredObservation(input, {
      candidateFor: (candidateId) => this.candidates.get(candidateId),
      now: () => this.now(),
      nextObservationId: () => this.ids.nextObservationId(),
      existingObservationIds: new Set(this.observations.keys()),
    });
  }

  private storeObservation(stored: ReadonlyStoredObservation): void {
    this.observations.set(stored.observationId, stored);
    const ids = this.observationIdsByCandidate.get(stored.candidateId) ?? [];
    ids.push(stored.observationId);
    this.observationIdsByCandidate.set(stored.candidateId, ids);
  }

  private validateReplacement(
    registration: ObservationRegistration,
    expectedObservationId: string,
  ): { readonly key: string; readonly observationIds: readonly string[] } {
    return validateObservationReplacement(registration, expectedObservationId, {
      candidateFor: (candidateId) => this.candidates.get(candidateId),
      observationFor: (observationId) => this.observations.get(observationId),
      observationsFor: (scope, candidateId) => this.listObservations(scope, candidateId),
      blockedFor: (key) => this.blockedReuse.get(key),
      suppressedFor: (key) => this.suppressedReuse.get(key),
      keyFor: reuseKey,
      now: () => this.now(),
    });
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
