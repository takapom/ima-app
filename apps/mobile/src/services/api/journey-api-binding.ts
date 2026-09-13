import type {
  CreateThreadRequest,
  LifecycleCommand,
  LocationSnapshot,
  SearchRequest,
  ThreadTurnRequest,
} from '@ima/contracts';
import type { JourneyConditions } from '../../state/journey-input';
import type { LocationService } from '../location/types';
import type { JourneyApiController } from './journey-controller-types';
import type { JourneyPhotoClient } from './photo-client';
import type { JourneyStorageService } from '../saved-places/journey-storage';
import type { SavedPlaceListService } from '../saved-places/saved-place-list';
import type { SavedReferenceService } from '../saved-reference-service';

export type JourneySavedPlacePreviewBinding = {
  /** The same owner-scoped SQLite projection used by the runtime save adapter. */
  readonly listService: SavedPlaceListService;
  /** The same authenticated client-backed refresh service used by runtime storage. */
  readonly refreshService: Pick<SavedReferenceService, 'refresh'>;
  /** The host clock keeps list, preview, and session boundaries on one timeline. */
  readonly now?: () => string;
};

export type JourneyApiSubmitContext = {
  readonly conditions: JourneyConditions;
  readonly removedChipLabels: readonly string[];
  /** The card set currently visible to the user, if any. */
  readonly cardSetId: string | null;
  readonly promotedCandidateId: string | null;
  readonly selectedCandidateId: string | null;
  readonly candidateOrder: readonly string[];
  /** Explicit saved references selected for this request; provider IDs never substitute here. */
  readonly savedPlaceRefs?: readonly string[];
  readonly excludeCandidateIds: readonly string[];
};

export type JourneyApiSearchFactoryInput = {
  readonly threadId: string;
  readonly revision: number;
  readonly query: string;
  readonly context: JourneyApiSubmitContext;
  /** Snapshot acquired for this explicit submit; omitted callers fail closed to unavailable. */
  readonly location?: LocationSnapshot;
};

export type JourneyApiTurnFactoryInput = JourneyApiSearchFactoryInput & {
  readonly turnId: string | null;
};

export type JourneyApiCancelFactoryInput = {
  readonly threadId: string;
  readonly revision: number;
  readonly turnId: string | null;
};

export type JourneyApiRequestFactory = {
  readonly createThread: () => CreateThreadRequest;
  readonly search: (input: JourneyApiSearchFactoryInput) => SearchRequest;
  readonly turn: (input: JourneyApiTurnFactoryInput) => ThreadTurnRequest;
  readonly cancel: (input: JourneyApiCancelFactoryInput) => LifecycleCommand;
};

export type JourneyApiControllerBinding = {
  readonly controller: JourneyApiController;
  readonly requests: JourneyApiRequestFactory;
  /** Host-composed explicit foreground location acquisition service. */
  readonly location?: LocationService;
  /** Authenticated binary photo access; absent when the host has no API composition. */
  readonly photoClient?: JourneyPhotoClient;
  /** Formal owner-scoped save adapter; absent when SQLite was not injected by the host. */
  readonly storage?: JourneyStorageService;
  /** Formal saved-list/preview adapter; absent when SQLite was not injected by the host. */
  readonly savedPlacePreview?: JourneySavedPlacePreviewBinding;
};
