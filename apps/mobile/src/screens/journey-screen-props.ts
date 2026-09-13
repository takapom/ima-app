import type { AssistantResponseClock } from '../services/assistant-response-clock';
import type {
  JourneyApiControllerBinding,
  JourneyApiSubmitContext,
  JourneySavedPlacePreviewBinding,
} from '../services/api/journey-api-binding';
import type { JourneyPhotoClient } from '../services/api/photo-client';
import type { JourneyActionServices } from '../hooks/useJourneyActions';
import type { WalkingMapDestinationResolver } from '../services/journey-map';
import type { JourneyPreferencesService } from '../services/preferences';
import type { JourneyStorageService } from '../services/saved-places/journey-storage';
import type { JourneySourceLinkService } from '../services/journey-source-link';
import type { AssistantResponseState } from '../state/assistant-response';
import type { ConditionScope, JourneyConditions } from '../state/journey-input';
import type { AssistantResponseProjectionNow } from '../state/assistant-response-projection';
import type { RecoverIntent } from '../state/journey-actions';
import type { SavedPlaceItem, SearchHistoryItem } from '../state/journey-shell';
import type { JourneyRequestStatus } from '../state/journey-phase';

export type JourneySubmitContext = JourneyApiSubmitContext;

export type JourneyScreenProps = {
  readonly threadId?: string;
  /** Optional HTTP composition; omitted hosts keep the fixture-free shell disconnected. */
  readonly api?: JourneyApiControllerBinding;
  /** Host-composed authenticated photo loader; omitted hosts show the public fallback. */
  readonly photoClient?: JourneyPhotoClient;
  readonly responseState?: AssistantResponseState | null;
  /** Injected render time for deterministic expiry boundaries. */
  readonly now?: AssistantResponseProjectionNow;
  readonly responseClock?: AssistantResponseClock;
  readonly requestStatus?: JourneyRequestStatus;
  readonly errorMessage?: string;
  readonly history?: readonly SearchHistoryItem[];
  /** True when the owner-scoped history store could not be read. */
  readonly historyUnavailable?: boolean;
  readonly savedPlaces?: readonly SavedPlaceItem[];
  readonly initialSavedConditions?: JourneyConditions;
  readonly onSubmit?: (query: string, context: JourneySubmitContext) => void;
  readonly onCancel?: () => void;
  readonly onRetry?: (query: string, context: JourneySubmitContext) => void;
  readonly onNewSearch?: () => void;
  readonly onPromote?: (candidateId: string) => void;
  readonly onRecover?: (intent: RecoverIntent) => void;
  readonly actionServices?: JourneyActionServices;
  /** Runtime-composed owner-scoped storage; absent hosts remain unavailable. */
  readonly storage?: JourneyStorageService;
  /** Runtime-composed SQLite-backed saved settings; absent hosts keep settings in memory. */
  readonly preferences?: JourneyPreferencesService;
  /** Runtime-composed saved list/preview; absent hosts keep the saved drawer unavailable. */
  readonly savedPlacePreview?: JourneySavedPlacePreviewBinding;
  readonly sourceLinkService?: JourneySourceLinkService;
  readonly mapDestinationResolver?: WalkingMapDestinationResolver;
  readonly onSourcePress?: (sourceLink: string) => void;
  readonly onHistorySelect?: (item: SearchHistoryItem) => void;
  readonly onSavedPlaceSelect?: (item: SavedPlaceItem) => void;
  readonly onConditionRemoved?: (label: string) => void;
  readonly onConditionsChange?: (
    scope: ConditionScope,
    changes: Partial<JourneyConditions>,
  ) => void;
};
