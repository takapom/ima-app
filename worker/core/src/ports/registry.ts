import type {
  CandidateRecord,
  CandidateRegistration,
  ObservationRegistration,
  ObservationReuseQuery,
  ObservationReuseResult,
  ReadonlyStoredObservation,
  StoredObservation,
} from '../domain/registry';
import type { RegistryScope } from '../domain/freshness';
import type { CandidateId, ObservationId } from '../domain/primitives';

export type ObservationReplacement = {
  /** The new immutable observation to publish after the expected observations are checked. */
  readonly registration: ObservationRegistration;
  /** The current unsuppressed observation used as the compare-and-set anchor. */
  readonly expectedObservationId: ObservationId;
};

export interface CandidateObservationRegistryPort {
  registerCandidate(input: CandidateRegistration): Readonly<CandidateRecord>;
  importCandidate(
    sourceScope: RegistryScope,
    targetScope: RegistryScope,
    candidateId: CandidateId,
    details: Pick<CandidateRegistration, 'displayName' | 'status'>,
  ): Readonly<CandidateRecord> | undefined;
  readCandidate(
    scope: RegistryScope,
    candidateId: CandidateId,
  ): Readonly<CandidateRecord> | undefined;
  listCandidates(scope: RegistryScope): readonly Readonly<CandidateRecord>[];
  excludeCandidate(scope: RegistryScope, candidateId: CandidateId): Readonly<CandidateRecord>;
  registerObservation(input: ObservationRegistration): Readonly<StoredObservation>;
  readObservation(
    scope: RegistryScope,
    observationId: string,
  ): ReadonlyStoredObservation | undefined;
  listObservations(
    scope: RegistryScope,
    candidateId?: CandidateId,
  ): readonly ReadonlyStoredObservation[];
  /** Registers a replacement before suppressing its current same-context reuse set. */
  replaceObservation(input: ObservationReplacement): ReadonlyStoredObservation;
  /** Blocks reuse after a failed/withheld refresh while retaining immutable history. */
  invalidateObservationReuse(scope: RegistryScope, candidateId: CandidateId, field: string): void;
  /** Reopens reuse only when the result names an observation created after invalidation. */
  restoreObservationReuse(
    scope: RegistryScope,
    candidateId: CandidateId,
    field: string,
    observationIds: readonly string[],
  ): boolean;
  evaluateObservationReuse(query: ObservationReuseQuery): ObservationReuseResult;
  findReusableObservation(query: ObservationReuseQuery): ReadonlyStoredObservation | undefined;
}
