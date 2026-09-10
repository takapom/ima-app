import { useCallback } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { PublicCard } from '@ima/contracts';
import { AppBar } from '../components/AppBar';
import { Canvas } from '../components/Canvas';
import { Composer } from '../components/Composer';
import { DecidedState } from '../components/DecidedState';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { ResultsState } from '../components/ResultsState';
import { WorkingState } from '../components/WorkingState';
import { useJourneyShell } from '../hooks/useJourneyShell';
import type { AssistantResponseState } from '../state/assistant-response';
import type { SavedPlaceItem, SearchHistoryItem } from '../state/journey-shell';

export type JourneyRequestStatus = 'idle' | 'pending' | 'error';

export type JourneyScreenProps = {
  readonly threadId?: string;
  readonly responseState?: AssistantResponseState;
  readonly requestStatus?: JourneyRequestStatus;
  readonly errorMessage?: string;
  readonly history?: readonly SearchHistoryItem[];
  readonly savedPlaces?: readonly SavedPlaceItem[];
  readonly onSubmit?: (query: string) => void;
  readonly onRetry?: (query: string) => void;
  readonly onNewSearch?: () => void;
  readonly onPromote?: (candidateId: string) => void;
  readonly onHistorySelect?: (item: SearchHistoryItem) => void;
  readonly onSavedPlaceSelect?: (item: SavedPlaceItem) => void;
};

const SUGGESTIONS = ['食後', '静か', '徒歩10分', '終電まで'] as const;

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
  onRetry,
  onNewSearch,
  onPromote,
  onHistorySelect,
  onSavedPlaceSelect,
}: JourneyScreenProps): React.JSX.Element {
  const journey = useJourneyShell(threadId);
  const renderedResponse = responseState ?? journey.responseState;

  const submit = useCallback(
    (value: string): void => {
      const query = value.trim();
      if (query.length === 0 || onSubmit === undefined) return;
      journey.beginRequest(value);
      onSubmit(value);
    },
    [journey.beginRequest, onSubmit],
  );
  const retry = useCallback((): void => {
    const query = journey.query.trim();
    if (query.length === 0 || onRetry === undefined) return;
    journey.beginRequest(journey.query);
    onRetry(journey.query);
  }, [journey.beginRequest, journey.query, onRetry]);
  const reset = useCallback((): void => {
    journey.reset();
    onNewSearch?.();
  }, [journey.reset, onNewSearch]);
  const decide = useCallback(
    (candidateId: string): void => journey.decide(candidateId, renderedResponse),
    [journey.decide, renderedResponse],
  );
  const phase = resolvePhase(requestStatus, journey.phase, renderedResponse);
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
            <ResultsState
              cards={renderedResponse.cards}
              messages={renderedResponse.messages}
              onDecide={decide}
              {...(onPromote === undefined ? {} : { onChoose: onPromote })}
            />
          ) : null}
          {phase === 'decided' ? <DecidedState card={decided} /> : null}
          {phase === 'error' ? (
            <ErrorState
              message={errorMessage}
              {...(onRetry === undefined ? {} : { onRetry: retry })}
            />
          ) : null}
        </ScrollView>
      </View>
      <Composer
        disabled={phase === 'working'}
        onChange={journey.updateDraft}
        placeholder={
          phase === 'empty' ? 'いま何してる？そのまま書いて' : 'ちがう条件も、そのまま書いて'
        }
        suggestions={journey.draft.trim().length > 0 ? SUGGESTIONS : []}
        value={journey.draft}
        {...(onSubmit === undefined ? {} : { onSubmit: submit })}
      />
      <Drawer
        history={history}
        onClose={journey.closeDrawer}
        onNewSearch={reset}
        onViewChange={journey.setDrawerView}
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
): ReturnType<typeof useJourneyShell>['phase'] => {
  if (requestStatus === 'pending') return 'working';
  if (requestStatus === 'error') return 'error';
  if (localPhase === 'decided') return 'decided';
  if (responseState.cards !== null || responseState.messages.length > 0) return 'results';
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
