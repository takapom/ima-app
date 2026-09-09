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
import type { CandidateId } from '../domain/primitives';

export interface CandidateObservationRegistryPort {
  registerCandidate(input: CandidateRegistration): Readonly<CandidateRecord>;
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
  evaluateObservationReuse(query: ObservationReuseQuery): ObservationReuseResult;
  findReusableObservation(query: ObservationReuseQuery): ReadonlyStoredObservation | undefined;
}
