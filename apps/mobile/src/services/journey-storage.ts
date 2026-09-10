import type { PublicCard } from '@ima/contracts';
import type { LocalSavedEntryId, ServerSavedPlaceRef } from './saved-place-types';

export type { LocalSavedEntryId, ServerSavedPlaceRef } from './saved-place-types';

/**
 * Keep public metadata at the storage boundary so the SQLite adapter can
 * inspect evidence/retention before deciding what may be persisted. The action
 * state still stores only candidate IDs and never copies this card.
 */
export type JourneySaveCandidate = PublicCard;

export type SaveCandidateResult =
  | {
      readonly status: 'saved';
      readonly localSavedEntryId: LocalSavedEntryId;
      readonly serverSavedPlaceRef: ServerSavedPlaceRef | null;
    }
  | {
      readonly status: 'already_saved';
      readonly localSavedEntryId: LocalSavedEntryId;
      readonly serverSavedPlaceRef: ServerSavedPlaceRef | null;
    }
  | { readonly status: 'failed'; readonly reason: 'storage_unavailable' | 'retention_denied' };

export type JourneyStorageService = {
  readonly saveCandidate: (candidate: JourneySaveCandidate) => Promise<SaveCandidateResult>;
};

/** SQLite is a later unit; never report an unpersisted candidate as saved. */
export const createUnavailableJourneyStorageService = (): JourneyStorageService => ({
  saveCandidate: () => Promise.resolve({ status: 'failed', reason: 'storage_unavailable' }),
});

/**
 * Keep storage failures at the service boundary. SQLite is connected in M21;
 * M20 callers can inject the same shape with an in-memory Fake.
 */
export const saveJourneyCandidate = async (
  service: JourneyStorageService,
  candidate: JourneySaveCandidate,
): Promise<SaveCandidateResult> => {
  try {
    return await service.saveCandidate(candidate);
  } catch {
    return { status: 'failed', reason: 'storage_unavailable' };
  }
};
