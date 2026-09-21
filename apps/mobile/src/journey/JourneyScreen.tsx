import { useJourneyApiController } from '@mobile/journey/hooks/useJourneyApiController';
import { useJourneyPreferences } from '@mobile/preferences/hooks/useJourneyPreferences';
import { JourneyScreenStateOwner } from '@mobile/journey/screen/JourneyScreenStateOwner';
import type { JourneyScreenProps } from '@mobile/journey/screen/journey-screen-props';

export type {
  JourneyScreenProps,
  JourneySubmitContext,
} from '@mobile/journey/screen/journey-screen-props';
export type { JourneyRequestStatus } from '@mobile/journey/state/journey-phase';

export function JourneyScreen(props: JourneyScreenProps): React.JSX.Element {
  const api = useJourneyApiController(props.api);
  const preferenceState = useJourneyPreferences({
    service: props.preferences,
    initialSavedConditions: props.initialSavedConditions,
  });
  const connectedPhotoClient = props.photoClient ?? props.api?.photoClient;
  const connectedStorage = props.storage ?? props.api?.storage;
  const connectedSavedPlacePreview = props.savedPlacePreview ?? props.api?.savedPlacePreview;
  const stateKey = api.connected
    ? `api-${api.state.threadId ?? props.threadId ?? 'auto'}-${api.viewKey}-${preferenceState.sourceKey}`
    : `${props.threadId ?? 'mobile-thread'}-${preferenceState.sourceKey}`;
  if (!api.connected) {
    return <JourneyScreenStateOwner key={stateKey} preferenceState={preferenceState} {...props} />;
  }
  const runApiTask = (task: Promise<unknown>): void => {
    void task.catch(() => api.reportUnexpected());
  };
  return (
    <JourneyScreenStateOwner
      key={stateKey}
      preferenceState={preferenceState}
      {...props}
      threadId={api.state.threadId ?? props.threadId ?? 'mobile-thread'}
      responseState={api.responseState}
      {...(connectedPhotoClient === undefined ? {} : { photoClient: connectedPhotoClient })}
      {...(connectedStorage === undefined ? {} : { storage: connectedStorage })}
      {...(connectedSavedPlacePreview === undefined
        ? {}
        : { savedPlacePreview: connectedSavedPlacePreview })}
      requestStatus={api.requestStatus}
      errorMessage={api.errorMessage ?? '時間をおいてもう一度試してください。'}
      onSubmit={(query, context) => {
        runApiTask(api.submit(query, context));
      }}
      onRetry={() => {
        runApiTask(api.retry());
      }}
      onCancel={() => {
        runApiTask(api.cancel());
      }}
      onNewSearch={api.reset}
      onHistorySelect={(item) => {
        runApiTask(api.selectHistory(item.id));
        props.onHistorySelect?.(item);
      }}
    />
  );
}
