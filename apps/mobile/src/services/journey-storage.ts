import type { PublicCard } from '@ima/contracts';

/**
 * Keep public metadata at the storage boundary so the SQLite adapter can
 * inspect evidence/retention before deciding what may be persisted. The action
 * state still stores only candidate IDs and never copies this card.
 */
export type JourneySaveCandidate = PublicCard;

export type SaveCandidateResult =
  | { readonly status: 'saved'; readonly savedPlaceRef: string }
  | { readonly status: 'already_saved'; readonly savedPlaceRef: string }
  | { readonly status: 'failed'; readonly reason: 'storage_unavailable' };

export type JourneyStorageService = {
  readonly saveCandidate: (candidate: JourneySaveCandidate) => Promise<SaveCandidateResult>;
};

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
