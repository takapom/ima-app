import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { AppBar } from '../components/AppBar';
import { Canvas } from '../components/Canvas';
import { Composer } from '../components/Composer';
import { ConditionChips } from '../components/ConditionChips';
import { DecidedState } from '../components/DecidedState';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { ResultsState } from '../components/ResultsState';
import { SavedPlacePreviewSurface } from '../components/SavedPlacePreviewSurface';
import { WorkingState } from '../components/WorkingState';
import { useAssistantResponseProjection } from '../hooks/useAssistantResponseProjection';
import { useJourneyActions } from '../hooks/useJourneyActions';
import { useJourneyShell } from '../hooks/useJourneyShell';
import {
  useJourneyPreferences,
  type UseJourneyPreferencesResult,
} from '../hooks/useJourneyPreferences';
import { useJourneySourceLink } from '../hooks/useJourneySourceLink';
import { useJourneySavedPlacePreview } from '../hooks/useJourneySavedPlacePreview';
import { selectedCardFor } from './journey-screen-model';
import { useJourneyApiController } from '../hooks/useJourneyApiController';
import { selectJourneyNoticeText } from '../services/journey-source-link';
import {
  selectAssistantMessageRecords,
  selectAssistantMessages,
} from '../state/assistant-response';
import {
  DEFAULT_SUGGESTIONS,
  type ConditionScope,
  type JourneyConditions,
  suggestionsFor,
} from '../state/journey-input';
import { resolveJourneyPhase } from '../state/journey-phase';
import type { JourneyScreenProps, JourneySubmitContext } from './journey-screen-props';

export type { JourneyScreenProps, JourneySubmitContext } from './journey-screen-props';
export type { JourneyRequestStatus } from '../state/journey-phase';

type JourneyScreenStateOwnerProps = JourneyScreenProps & {
  readonly preferenceState: UseJourneyPreferencesResult;
};

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

function JourneyScreenStateOwner({
  threadId = 'mobile-thread',
  responseState,
  now,
  responseClock,
  requestStatus = 'idle',
  errorMessage = '時間をおいてもう一度試してください。',
  history = [],
  savedPlaces,
  onSubmit,
  onCancel,
  onRetry,
  onNewSearch,
  onPromote,
  onRecover,
  actionServices,
  storage,
  mapDestinationResolver,
  onSourcePress,
  onHistorySelect,
  onSavedPlaceSelect,
  onConditionRemoved,
  onConditionsChange,
  photoClient,
  sourceLinkService,
  savedPlacePreview,
  preferenceState,
}: JourneyScreenStateOwnerProps): React.JSX.Element {
  const persistedPreferences = preferenceState;
  const journey = useJourneyShell(threadId, persistedPreferences.savedConditions);
  const savedPlaceUi = useJourneySavedPlacePreview(
    savedPlacePreview,
    onSavedPlaceSelect,
    requestStatus === 'pending' || journey.phase === 'working',
  );
  const renderedResponse = useAssistantResponseProjection(
    responseState ?? journey.responseState,
    now,
    responseClock,
  );
  const [requestStartRevision, setRequestStartRevision] = useState<number | null>(null);
  const lastObservedResponseRevision = useRef(renderedResponse.revision);
  useEffect(() => {
    if (renderedResponse.revision <= lastObservedResponseRevision.current) return;
    lastObservedResponseRevision.current = renderedResponse.revision;
    if (
      requestStatus === 'error' ||
      requestStatus === 'cancelled' ||
      requestStartRevision === null ||
      renderedResponse.revision <= requestStartRevision
    ) {
      if (requestStatus === 'error' || requestStatus === 'cancelled') {
        setRequestStartRevision(null);
      }
      return;
    }
    journey.settleResponse(renderedResponse.revision);
    savedPlaceUi.responseSettled();
    setRequestStartRevision((current) =>
      current !== null && renderedResponse.revision > current ? null : current,
    );
  }, [
    journey.settleResponse,
    renderedResponse,
    requestStartRevision,
    requestStatus,
    savedPlaceUi.responseSettled,
  ]);
  useEffect(() => {
    if (requestStatus === 'error' || requestStatus === 'cancelled') {
      setRequestStartRevision(null);
    }
  }, [requestStatus]);
  useEffect(() => {
    if (requestStatus === 'error') journey.failRequest(errorMessage);
    if (requestStatus === 'cancelled') journey.cancelRequest();
  }, [errorMessage, journey.cancelRequest, journey.failRequest, requestStatus]);
  const renderedMessages = selectAssistantMessages(renderedResponse);
  const actions = useJourneyActions({
    threadId,
    responseState: renderedResponse,
    query: journey.query,
    ...(actionServices === undefined ? {} : { actionServices }),
    ...(storage === undefined ? {} : { storage }),
    ...(mapDestinationResolver === undefined ? {} : { mapDestinationResolver }),
    ...(onPromote === undefined ? {} : { onPromote }),
    ...(onRecover === undefined ? {} : { onRecover }),
  });
  const sourceLink = useJourneySourceLink({
    contextKey: [
      threadId,
      renderedResponse.cardSetId ?? '',
      renderedResponse.cardSetDisplay.kind === 'kept'
        ? (renderedResponse.cardSetDisplay.sourceResponseId ?? '')
        : (renderedResponse.cardSetDisplay.responseId ?? ''),
    ].join(':'),
    service: sourceLinkService ?? actions.sourceLinkService,
  });
  useEffect(() => {
    if (actions.notice !== null) sourceLink.clear();
  }, [actions.notice, sourceLink.clear]);
  const renderedMessageRecords = selectAssistantMessageRecords(renderedResponse);

  const submit = useCallback(
    (value: string): void => {
      const query = value.trim();
      if (query.length === 0 || onSubmit === undefined) return;
      const context: JourneySubmitContext = {
        conditions: journey.conditions,
        removedChipLabels: journey.removedChipLabels,
        cardSetId: renderedResponse.cardSetId,
        promotedCandidateId: actions.state.promotedCandidateId,
        selectedCandidateId: actions.state.decidedCandidateId,
        candidateOrder: actions.candidateOrder,
        savedPlaceRefs: savedPlaceUi.pendingRefs,
        excludeCandidateIds: actions.state.tonightExcludedCandidateIds,
      };
      setRequestStartRevision(renderedResponse.revision);
      journey.beginRequest(value);
      onSubmit(value, context);
    },
    [
      actions.candidateOrder,
      actions.state.decidedCandidateId,
      actions.state.promotedCandidateId,
      actions.state.tonightExcludedCandidateIds,
      savedPlaceUi.pendingRefs,
      journey.beginRequest,
      journey.conditions,
      journey.removedChipLabels,
      renderedResponse.cardSetId,
      renderedResponse.revision,
      onSubmit,
    ],
  );
  const retry = useCallback((): void => {
    const query = journey.query.trim();
    const retryHandler = onRetry ?? onSubmit;
    if (query.length === 0 || retryHandler === undefined) return;
    const context: JourneySubmitContext = {
      conditions: journey.conditions,
      removedChipLabels: journey.removedChipLabels,
      cardSetId: renderedResponse.cardSetId,
      promotedCandidateId: actions.state.promotedCandidateId,
      selectedCandidateId: actions.state.decidedCandidateId,
      candidateOrder: actions.candidateOrder,
      savedPlaceRefs: savedPlaceUi.pendingRefs,
      excludeCandidateIds: actions.state.tonightExcludedCandidateIds,
    };
    setRequestStartRevision(renderedResponse.revision);
    journey.beginRequest(journey.query);
    retryHandler(journey.query, context);
  }, [
    journey.beginRequest,
    journey.conditions,
    journey.query,
    journey.removedChipLabels,
    renderedResponse.cardSetId,
    renderedResponse.revision,
    onRetry,
    onSubmit,
    actions.candidateOrder,
    actions.state.decidedCandidateId,
    actions.state.promotedCandidateId,
    actions.state.tonightExcludedCandidateIds,
    savedPlaceUi.pendingRefs,
  ]);
  const cancel = useCallback((): void => {
    setRequestStartRevision(null);
    actions.cancelPending();
    journey.cancelRequest();
    onCancel?.();
  }, [actions.cancelPending, journey.cancelRequest, onCancel]);
  const reset = useCallback((): void => {
    setRequestStartRevision(null);
    savedPlaceUi.reset();
    actions.reset();
    journey.reset();
    onNewSearch?.();
  }, [actions.reset, journey.reset, onNewSearch, savedPlaceUi.reset]);
  const decide = useCallback(
    (candidateId: string): void => {
      if (!actions.decide(candidateId)) return;
      journey.decide(candidateId, renderedResponse);
    },
    [actions.decide, journey.decide, renderedResponse],
  );
  const recover = useCallback((): void => {
    if (actions.state.decidedCandidateId !== null) {
      const intent = actions.recover(actions.state.decidedCandidateId);
      if (intent !== null) {
        setRequestStartRevision(renderedResponse.revision);
        journey.beginRequest(intent.query);
      }
    }
  }, [
    actions.recover,
    actions.state.decidedCandidateId,
    journey.beginRequest,
    renderedResponse.revision,
  ]);
  const removeChip = useCallback(
    (label: string): void => {
      journey.removeChip(label);
      onConditionRemoved?.(label);
    },
    [journey.removeChip, onConditionRemoved],
  );
  const changeConditions = useCallback(
    (scope: ConditionScope, changes: Partial<JourneyConditions>): void => {
      const result = persistedPreferences.applyConditionChange(
        scope,
        persistedPreferences.savedConditions,
        changes,
      );
      if (!result.applied) return;
      journey.updateConditions(
        scope,
        scope === 'saved' ? { ...persistedPreferences.savedConditions, ...changes } : changes,
      );
      onConditionsChange?.(scope, changes);
    },
    [
      journey.updateConditions,
      onConditionsChange,
      persistedPreferences.applyConditionChange,
      persistedPreferences.savedConditions,
    ],
  );
  const openSourceLink = useCallback(
    (sourceLinkValue: string): void => {
      actions.clearNotice();
      if (onSourcePress !== undefined) {
        onSourcePress(sourceLinkValue);
        return;
      }
      sourceLink.open(sourceLinkValue);
    },
    [actions.clearNotice, onSourcePress, sourceLink.open],
  );
  const decided = selectedCardFor(renderedResponse, actions.state.decidedCandidateId);
  const phase = resolveJourneyPhase(
    requestStatus,
    journey.phase,
    renderedResponse.cards !== null || renderedMessages.length > 0,
    decided !== null,
    requestStartRevision !== null && renderedResponse.revision > requestStartRevision,
  );
  const visibleSavedPlaces = savedPlaces ?? [];
  const savedPlacesUnavailable = savedPlaceUi.connected
    ? savedPlaceUi.unavailable
    : savedPlaces === undefined;

  return (
    <Canvas>
      <AppBar onMenu={journey.toggleDrawer} onNewSearch={reset} />
      <View style={styles.content}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {phase === 'empty' ? <EmptyState onExample={journey.updateDraft} /> : null}
          {phase === 'working' ? <WorkingState query={journey.query} /> : null}
          {phase === 'results' ? (
            <ConditionChips chips={journey.chips} onRemove={removeChip} />
          ) : null}
          {phase === 'results' ? (
            <ResultsState
              cards={renderedResponse.cards}
              cardSetId={renderedResponse.cardSetId}
              cardSetDisplay={renderedResponse.cardSetDisplay}
              messageRecords={renderedMessageRecords}
              candidateOrder={actions.candidateOrder}
              notice={selectJourneyNoticeText(
                actions.notice?.text ?? null,
                sourceLink.notice?.text ?? null,
              )}
              onDecide={decide}
              onSave={(card) => {
                void actions.save(card).then(savedPlaceUi.reload).catch(actions.reportFailure);
              }}
              onSkip={actions.skipTonight}
              onSourcePress={openSourceLink}
              {...(photoClient === undefined ? {} : { photoClient })}
              onChoose={actions.promote}
            />
          ) : null}
          {phase === 'decided' ? (
            <DecidedState
              card={decided}
              notice={actions.notice?.text ?? null}
              {...(decided === null
                ? {}
                : {
                    onOpenMap: () => {
                      void actions.openMap(decided).catch(actions.reportFailure);
                    },
                    onSave: (card) => {
                      void actions
                        .save(card)
                        .then(savedPlaceUi.reload)
                        .catch(actions.reportFailure);
                    },
                    onShare: () => {
                      void actions.share(decided).catch(actions.reportFailure);
                    },
                  })}
              {...(actions.state.decidedCandidateId === null || onRecover === undefined
                ? {}
                : { onRecover: recover })}
            />
          ) : null}
          {phase === 'error' ? (
            <ErrorState
              message={errorMessage}
              {...(onRetry === undefined && onSubmit === undefined ? {} : { onRetry: retry })}
            />
          ) : null}
          {phase === 'cancelled' ? (
            <ErrorState
              message="入力内容は残しています。編集してから再送できます。"
              title="検索を取り消しました"
              {...(onRetry === undefined && onSubmit === undefined ? {} : { onRetry: retry })}
            />
          ) : null}
        </ScrollView>
      </View>
      <SavedPlacePreviewSurface controller={savedPlaceUi} onSourcePress={openSourceLink} />
      <Composer
        disabled={phase === 'working'}
        onChange={journey.updateDraft}
        onCancel={cancel}
        placeholder={
          phase === 'empty' ? 'いま何してる？そのまま書いて' : 'ちがう条件も、そのまま書いて'
        }
        pending={phase === 'working'}
        suggestions={
          journey.draft.trim().length > 0 ? suggestionsFor(journey.draft, DEFAULT_SUGGESTIONS) : []
        }
        value={journey.draft}
        {...(onSubmit === undefined ? {} : { onSubmit: submit })}
      />
      <Drawer
        history={history}
        onClose={journey.closeDrawer}
        onNewSearch={reset}
        onViewChange={journey.setDrawerView}
        conditions={journey.conditions}
        savedConditions={persistedPreferences.savedConditions}
        conditionScope={journey.conditionScope}
        conditionNotice={persistedPreferences.conditionNotice}
        onConditionScopeChange={journey.changeConditionScope}
        onConditionsChange={changeConditions}
        open={journey.drawerOpen}
        savedPlaces={savedPlaceUi.connected ? savedPlaceUi.items : visibleSavedPlaces}
        savedPlacesUnavailable={savedPlacesUnavailable}
        view={journey.drawerView}
        {...(onHistorySelect === undefined ? {} : { onHistorySelect })}
        {...(savedPlaceUi.connected || onSavedPlaceSelect !== undefined
          ? { onSavedPlaceSelect: savedPlaceUi.selectDrawerItem }
          : {})}
      />
    </Canvas>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: 4,
  },
});
