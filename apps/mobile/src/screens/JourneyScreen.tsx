import { useCallback } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { PublicCard, PublicMessage } from '@ima/contracts';
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
import { useJourneyShell } from '../hooks/useJourneyShell';
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
import type { SavedPlaceItem, SearchHistoryItem } from '../state/journey-shell';

export type JourneyRequestStatus = 'idle' | 'pending' | 'error' | 'cancelled';

export type JourneySubmitContext = {
  readonly conditions: JourneyConditions;
  readonly removedChipLabels: readonly string[];
};

export type JourneyScreenProps = {
  readonly threadId?: string;
  readonly responseState?: AssistantResponseState;
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
  onHistorySelect,
  onSavedPlaceSelect,
  onConditionRemoved,
  onConditionsChange,
}: JourneyScreenProps): React.JSX.Element {
  const journey = useJourneyShell(threadId, initialSavedConditions);
  const renderedResponse = responseState ?? journey.responseState;
  const renderedMessages = selectAssistantMessages(renderedResponse);
  const renderedMessageRecords = selectAssistantMessageRecords(renderedResponse);

  const submit = useCallback(
    (value: string): void => {
      const query = value.trim();
      if (query.length === 0 || onSubmit === undefined) return;
      const context: JourneySubmitContext = {
        conditions: journey.conditions,
        removedChipLabels: journey.removedChipLabels,
      };
      journey.beginRequest(value);
      onSubmit(value, context);
    },
    [journey.beginRequest, journey.conditions, journey.removedChipLabels, onSubmit],
  );
  const retry = useCallback((): void => {
    const query = journey.query.trim();
    const retryHandler = onRetry ?? onSubmit;
    if (query.length === 0 || retryHandler === undefined) return;
    const context: JourneySubmitContext = {
      conditions: journey.conditions,
      removedChipLabels: journey.removedChipLabels,
    };
    journey.beginRequest(journey.query);
    retryHandler(journey.query, context);
  }, [
    journey.beginRequest,
    journey.conditions,
    journey.query,
    journey.removedChipLabels,
    onRetry,
    onSubmit,
  ]);
  const cancel = useCallback((): void => {
    journey.cancelRequest();
    onCancel?.();
  }, [journey.cancelRequest, onCancel]);
  const reset = useCallback((): void => {
    journey.reset();
    onNewSearch?.();
  }, [journey.reset, onNewSearch]);
  const decide = useCallback(
    (candidateId: string): void => journey.decide(candidateId, renderedResponse),
    [journey.decide, renderedResponse],
  );
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
  const phase = resolvePhase(requestStatus, journey.phase, renderedResponse, renderedMessages);
  const decided = selectedCard(renderedResponse, journey.selectedCandidateId);

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
              onDecide={decide}
              {...(onPromote === undefined ? {} : { onChoose: onPromote })}
            />
          ) : null}
          {phase === 'decided' ? <DecidedState card={decided} /> : null}
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

const resolvePhase = (
  requestStatus: JourneyRequestStatus,
  localPhase: ReturnType<typeof useJourneyShell>['phase'],
  responseState: AssistantResponseState,
  messages: readonly PublicMessage[],
): ReturnType<typeof useJourneyShell>['phase'] => {
  if (requestStatus === 'pending') return 'working';
  if (requestStatus === 'error') return 'error';
  if (requestStatus === 'cancelled') return 'cancelled';
  if (localPhase === 'cancelled') return 'cancelled';
  if (localPhase === 'error') return 'error';
  if (localPhase === 'decided') return 'decided';
  if (responseState.cards !== null || messages.length > 0) return 'results';
  if (localPhase === 'working') return 'working';
  return 'empty';
};

const styles = StyleSheet.create({
  content: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: 4,
  },
});
