import type { ReactNode } from 'react';
import type { ConversationNavigation } from '@mobile/journey/components/conversations/ConversationHistoryList';
import type { AssistantResponseClock } from '@mobile/journey/services/assistant-response-clock';
import type {
  JourneyApiControllerBinding,
  JourneyApiSubmitContext,
  JourneySavedPlacePreviewBinding,
} from '@mobile/journey/services/thread-session/journey-api-binding';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import type { JourneyActionServices } from '@mobile/journey/hooks/useJourneyActions';
import type { WalkingMapDestinationResolver } from '@mobile/journey/services/journey-map';
import type { JourneyPreferencesService } from '@mobile/preferences/services/preferences';
import type { JourneyStorageService } from '@mobile/saved-places/services/journey-storage';
import type { JourneySourceLinkService } from '@mobile/journey/services/journey-source-link';
import type {
  AssistantMessageRecord,
  AssistantResponseState,
} from '@mobile/journey/state/assistant-response';
import type { ConditionScope, JourneyConditions } from '@mobile/preferences/state/conditions';
import type { AssistantResponseProjectionNow } from '@mobile/journey/state/assistant-response-projection';
import type { RecoverIntent } from '@mobile/journey/state/journey-actions';
import type { SavedPlaceItem, SearchHistoryItem } from '@mobile/journey/state/journey-shell';
import type { JourneyRequestStatus } from '@mobile/journey/state/journey-phase';
import type { HistoryPhotoViewport } from '@mobile/journey/state/history-photo-viewport';
import type { CardSetFocus } from '@mobile/journey/state/card-set-focus';

export type JourneySubmitContext = JourneyApiSubmitContext;

export type JourneyScreenProps = {
  readonly conversation?: {
    readonly navigation: ConversationNavigation;
    readonly renderTranscript: (
      liveMessages: readonly AssistantMessageRecord[],
      onSourcePress: (sourceLink: string) => void,
      photoViewport: HistoryPhotoViewport,
      cardFocus: CardSetFocus,
    ) => ReactNode;
    readonly hasMessages: boolean;
  };
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
  /** Sent once as the first message when the screen opens, e.g. the entry question answers. */
  readonly initialQuery?: string;
  /** Called when `initialQuery` has been sent, so the host stops passing it. */
  readonly onInitialQuerySent?: () => void;
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
