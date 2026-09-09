import type { RegistryScope } from '../domain/freshness';
import type { ObservationContext } from '../domain/freshness';
import type {
  CardSetRecord,
  CardSetRegistration,
  CandidateFieldResultRecord,
  SavedPlaceCandidateDetails,
  SavedPlaceReference,
  SavedPlaceRegistration,
} from '../domain/continuity';
import type { CandidateRecord, ReadonlyStoredObservation } from '../domain/registry';
import type { CandidateId, CardSetId, OpaqueId, SavedPlaceRef } from '../domain/primitives';

export interface SavedPlaceReferencePort {
  registerSavedPlace(input: SavedPlaceRegistration): Readonly<SavedPlaceReference>;
  readSavedPlace(
    ownerScopeRef: OpaqueId,
    savedPlaceRef: SavedPlaceRef,
  ): Readonly<SavedPlaceReference> | undefined;
  deleteSavedPlace(ownerScopeRef: OpaqueId, savedPlaceRef: SavedPlaceRef): boolean;
  importSavedPlace(
    scope: RegistryScope,
    savedPlaceRef: SavedPlaceRef,
    details: SavedPlaceCandidateDetails,
  ): Readonly<CandidateRecord> | undefined;
}

export interface CardSetPort {
  createCardSet(input: CardSetRegistration): Readonly<CardSetRecord>;
  readCardSet(scope: RegistryScope, cardSetId: CardSetId): Readonly<CardSetRecord> | undefined;
  selectCard(
    scope: RegistryScope,
    cardSetId: CardSetId,
    candidateId: CandidateId,
  ): Readonly<CardSetRecord>;
  excludeCard(
    scope: RegistryScope,
    cardSetId: CardSetId,
    candidateId: CandidateId,
  ): Readonly<CardSetRecord>;
}

export interface CandidateFieldResultPort {
  registerFieldResult(
    scope: RegistryScope,
    candidateId: CandidateId,
    field: string,
    result: unknown,
  ): Readonly<CandidateFieldResultRecord>;
  readFieldResult(
    scope: RegistryScope,
    candidateId: CandidateId,
    field: string,
  ): Readonly<CandidateFieldResultRecord> | undefined;
  listFieldResults(
    scope: RegistryScope,
    candidateId: CandidateId,
  ): readonly Readonly<CandidateFieldResultRecord>[];
  findReusableObservation(
    scope: RegistryScope,
    candidateId: CandidateId,
    field: string,
    context: ObservationContext,
  ): ReadonlyStoredObservation | undefined;
}
