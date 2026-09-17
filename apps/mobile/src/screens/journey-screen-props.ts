import type { AssistantResponseClock } from '@mobile/services/assistant-response-clock';
import type {
  JourneyApiControllerBinding,
  JourneyApiSubmitContext,
  JourneySavedPlacePreviewBinding,
} from '@mobile/services/thread-session/journey-api-binding';
import type { JourneyPhotoClient } from '@mobile/services/api/photo-client';
import type { JourneyActionServices } from '@mobile/hooks/useJourneyActions';
import type { WalkingMapDestinationResolver } from '@mobile/services/journey-map';
import type { JourneyPreferencesService } from '@mobile/services/preferences';
import type { JourneyStorageService } from '@mobile/services/saved-places/journey-storage';
import type { JourneySourceLinkService } from '@mobile/services/journey-source-link';
import type { AssistantResponseState } from '@mobile/state/assistant-response';
import type { ConditionScope, JourneyConditions } from '@mobile/state/journey-input';
import type { AssistantResponseProjectionNow } from '@mobile/state/assistant-response-projection';
import type { RecoverIntent } from '@mobile/state/journey-actions';
import type { SavedPlaceItem, SearchHistoryItem } from '@mobile/state/journey-shell';
import type { JourneyRequestStatus } from '@mobile/state/journey-phase';

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
