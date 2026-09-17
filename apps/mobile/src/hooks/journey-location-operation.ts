import type { LocationSnapshot } from '@ima/contracts';
import type { JourneyApiSubmitContext } from '@mobile/services/thread-session/journey-api-binding';
import type { LocationService } from '@mobile/services/location/types';

export type JourneyLocationPreparation =
  { readonly kind: 'ready'; readonly snapshot: LocationSnapshot } | { readonly kind: 'cancelled' };

export type JourneyLocationDraft = {
  readonly query: string;
  readonly context: JourneyApiSubmitContext;
  readonly threadId: string | null;
  readonly revision: number;
  readonly turnId: string | null;
};

export type JourneyLocationScope = Pick<JourneyLocationDraft, 'threadId' | 'revision' | 'turnId'>;

/** Keeps a cancelled, not-yet-submitted draft from crossing a thread scope. */
export const locationDraftScopeMatches = (
  draft: JourneyLocationScope,
  current: JourneyLocationScope,
): boolean =>
  draft.threadId === current.threadId &&
  draft.revision === current.revision &&
  draft.turnId === current.turnId;

export const unavailableJourneyLocation = (): LocationSnapshot => ({
  status: 'unavailable',
  lat: null,
  lng: null,
  accuracyMeters: null,
  precise: false,
  capturedAt: null,
});

/**
 * Acquires only for a submit owned by the caller. A missing or failing host
 * service keeps text search usable while never fabricating coordinates.
 */
export const prepareJourneyLocation = async (
  service: LocationService | undefined,
  signal: AbortSignal,
): Promise<JourneyLocationPreparation> => {
  if (signal.aborted) return { kind: 'cancelled' };
  if (service === undefined) {
    return { kind: 'ready', snapshot: unavailableJourneyLocation() };
  }
  try {
    const result = await service.acquire({ signal });
    if (signal.aborted || result.status === 'cancelled') return { kind: 'cancelled' };
    return { kind: 'ready', snapshot: result };
  } catch {
    return signal.aborted
      ? { kind: 'cancelled' }
      : { kind: 'ready', snapshot: unavailableJourneyLocation() };
  }
};
