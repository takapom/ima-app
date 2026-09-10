import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { PublicCard } from '@ima/contracts';
import { AppBar } from '../components/AppBar';
import { Canvas } from '../components/Canvas';
import { Composer } from '../components/Composer';
import { ConditionChips } from '../components/ConditionChips';
import { DecidedState } from '../components/DecidedState';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { ResultsState } from '../components/ResultsState';
import { WorkingState } from '../components/WorkingState';
import { useAssistantResponseProjection } from '../hooks/useAssistantResponseProjection';
import { useJourneyActions, type JourneyActionServices } from '../hooks/useJourneyActions';
import { useJourneyShell } from '../hooks/useJourneyShell';
import type { AssistantResponseClock } from '../services/assistant-response-clock';
import type { WalkingMapDestinationResolver } from '../services/journey-map';
import {
  selectAssistantMessageRecords,
  selectAssistantMessages,
  type AssistantResponseState,
} from '../state/assistant-response';
import {
  DEFAULT_SUGGESTIONS,
  type ConditionScope,
  type JourneyConditions,
  suggestionsFor,
} from '../state/journey-input';
import type { AssistantResponseProjectionNow } from '../state/assistant-response-projection';
import type { SavedPlaceItem, SearchHistoryItem } from '../state/journey-shell';
import type { RecoverIntent } from '../state/journey-actions';
import { resolveJourneyPhase, type JourneyRequestStatus } from '../state/journey-phase';

export type { JourneyRequestStatus } from '../state/journey-phase';

export type JourneySubmitContext = {
  readonly conditions: JourneyConditions;
  readonly removedChipLabels: readonly string[];
  readonly promotedCandidateId: string | null;
  readonly selectedCandidateId: string | null;
  readonly candidateOrder: readonly string[];
};

export type JourneyScreenProps = {
  readonly threadId?: string;
  readonly responseState?: AssistantResponseState;
  /** Injected render time for deterministic expiry boundaries. */
  readonly now?: AssistantResponseProjectionNow;
  readonly responseClock?: AssistantResponseClock;
  readonly requestStatus?: JourneyRequestStatus;
  readonly errorMessage?: string;
  readonly history?: readonly SearchHistoryItem[];
  readonly savedPlaces?: readonly SavedPlaceItem[];
  readonly initialSavedConditions?: JourneyConditions;
  readonly onSubmit?: (query: string, context: JourneySubmitContext) => void;
  readonly onCancel?: () => void;
  readonly onRetry?: (query: string, context: JourneySubmitContext) => void;
  readonly onNewSearch?: () => void;
  readonly onPromote?: (candidateId: string) => void;
  readonly onRecover?: (intent: RecoverIntent) => void;
  readonly actionServices?: JourneyActionServices;
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

export function JourneyScreen(props: JourneyScreenProps): React.JSX.Element {
  const stateKey = props.threadId ?? 'mobile-thread';
  return <JourneyScreenStateOwner key={stateKey} {...props} />;
}

const selectedCard = (
  responseState: AssistantResponseState,
  candidateId: string | null,
): PublicCard | null => {
  if (responseState.cards === null || candidateId === null) return null;
  return (
    [responseState.cards.hero, ...responseState.cards.alts].find(
      (card) => card.candidateId === candidateId,
    ) ?? null
  );
};

function JourneyScreenStateOwner({
  threadId = 'mobile-thread',
  responseState,
  now,
  responseClock,
  requestStatus = 'idle',
  errorMessage = '時間をおいてもう一度試してください。',
  history = [],
  savedPlaces = [],
  onSubmit,
  initialSavedConditions,
  onCancel,
  onRetry,
  onNewSearch,
  onPromote,
  onRecover,
  actionServices,
  mapDestinationResolver,
  onSourcePress,
  onHistorySelect,
  onSavedPlaceSelect,
  onConditionRemoved,
  onConditionsChange,
}: JourneyScreenProps): React.JSX.Element {
  const journey = useJourneyShell(threadId, initialSavedConditions);
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
    setRequestStartRevision((current) =>
      current !== null && renderedResponse.revision > current ? null : current,
    );
  }, [journey.settleResponse, renderedResponse, requestStartRevision, requestStatus]);
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
    ...(mapDestinationResolver === undefined ? {} : { mapDestinationResolver }),
    ...(onPromote === undefined ? {} : { onPromote }),
    ...(onRecover === undefined ? {} : { onRecover }),
  });
  const renderedMessageRecords = selectAssistantMessageRecords(renderedResponse);

  const submit = useCallback(
    (value: string): void => {
      const query = value.trim();
      if (query.length === 0 || onSubmit === undefined) return;
      const context: JourneySubmitContext = {
        conditions: journey.conditions,
        removedChipLabels: journey.removedChipLabels,
        promotedCandidateId: actions.state.promotedCandidateId,
        selectedCandidateId: actions.state.decidedCandidateId,
        candidateOrder: actions.candidateOrder,
      };
      setRequestStartRevision(renderedResponse.revision);
      journey.beginRequest(value);
      onSubmit(value, context);
    },
    [
      actions.candidateOrder,
      actions.state.decidedCandidateId,
      actions.state.promotedCandidateId,
      journey.beginRequest,
      journey.conditions,
      journey.removedChipLabels,
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
      promotedCandidateId: actions.state.promotedCandidateId,
      selectedCandidateId: actions.state.decidedCandidateId,
      candidateOrder: actions.candidateOrder,
    };
    setRequestStartRevision(renderedResponse.revision);
    journey.beginRequest(journey.query);
    retryHandler(journey.query, context);
  }, [
    journey.beginRequest,
    journey.conditions,
    journey.query,
    journey.removedChipLabels,
    renderedResponse.revision,
    onRetry,
    onSubmit,
    actions.candidateOrder,
    actions.state.decidedCandidateId,
    actions.state.promotedCandidateId,
  ]);
  const cancel = useCallback((): void => {
    setRequestStartRevision(null);
    journey.cancelRequest();
    onCancel?.();
  }, [journey.cancelRequest, onCancel]);
  const reset = useCallback((): void => {
    setRequestStartRevision(null);
    actions.reset();
    journey.reset();
    onNewSearch?.();
  }, [actions.reset, journey.reset, onNewSearch]);
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
      journey.updateConditions(scope, changes);
      onConditionsChange?.(scope, changes);
    },
    [journey.updateConditions, onConditionsChange],
  );
  const decided = selectedCard(renderedResponse, actions.state.decidedCandidateId);
  const phase = resolveJourneyPhase(
    requestStatus,
    journey.phase,
    renderedResponse.cards !== null || renderedMessages.length > 0,
    decided !== null,
    requestStartRevision !== null && renderedResponse.revision > requestStartRevision,
  );

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
              notice={actions.notice?.text ?? null}
              onDecide={decide}
              onSave={(card) => {
                void actions.save(card).catch(actions.reportFailure);
              }}
              onSkip={actions.skipTonight}
              {...(onSourcePress === undefined ? {} : { onSourcePress })}
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
                      void actions.save(card).catch(actions.reportFailure);
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
        savedConditions={journey.savedConditions}
        conditionScope={journey.conditionScope}
        onConditionScopeChange={journey.changeConditionScope}
        onConditionsChange={changeConditions}
        open={journey.drawerOpen}
        savedPlaces={savedPlaces}
        view={journey.drawerView}
        {...(onHistorySelect === undefined ? {} : { onHistorySelect })}
        {...(onSavedPlaceSelect === undefined ? {} : { onSavedPlaceSelect })}
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
