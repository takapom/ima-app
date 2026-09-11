import type { PublicCard, RetentionMetadata } from '@ima/contracts';
import type { AssistantResponseState } from '../../state/assistant-response';
import type { JourneyApiController, JourneyLocalRestorePort } from './journey-controller-types';
import type { SnapshotInput, SqliteStore, ThreadInput } from '../sqlite/types';

type LocalSessionController = Pick<JourneyApiController, 'getState' | 'subscribe'>;
type LocalSessionStore = Pick<SqliteStore, 'saveThread' | 'writeSnapshot'>;
type LocalSessionRestoreStore = Pick<SqliteStore, 'readSnapshot'>;

export type LocalSessionPersistenceOptions = {
  readonly controller: LocalSessionController;
  readonly store: LocalSessionStore;
  readonly now?: () => string;
};

export type LocalSessionPersistence = {
  /** Captures the current controller state; failures are intentionally swallowed. */
  readonly capture: () => void;
  readonly dispose: () => void;
};

type RetentionBounds = {
  readonly sessionExpiresAt: string;
  readonly displayUntil: string | null;
  readonly retentionUntil: string | null;
  readonly deletionScheduledAt: string | null;
};

type SnapshotCandidate = {
  readonly thread: ThreadInput;
  readonly snapshot: SnapshotInput;
};

const millisecondsFor = (value: string): number | null => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
};

const earliestDeadline = (
  values: readonly (string | null)[],
  nowMilliseconds: number,
): string | null => {
  let earliest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    const milliseconds = millisecondsFor(value);
    if (milliseconds === null || milliseconds <= nowMilliseconds) return null;
    if (earliest === null || milliseconds < earliest) earliest = milliseconds;
  }
  return earliest === null ? null : new Date(earliest).toISOString();
};

const retentionsForText = (
  value: Pick<PublicCard['why'], 'retention' | 'evidence'>,
): readonly RetentionMetadata[] => [
  value.retention,
  ...value.evidence.map((evidence) => evidence.retention),
];

const retentionsForCard = (card: PublicCard): readonly RetentionMetadata[] => [
  ...retentionsForText(card.why),
  ...(card.diff === undefined ? [] : retentionsForText(card.diff)),
  ...Object.values(card.facts).flatMap((field) =>
    field?.status === 'known' ? field.evidence.map((evidence) => evidence.retention) : [],
  ),
];

const retentionsForState = (state: AssistantResponseState): readonly RetentionMetadata[] => [
  ...state.responseRecords.flatMap((record) =>
    record.messages.flatMap((message) => retentionsForText(message)),
  ),
  ...(state.cards === null
    ? []
    : [state.cards.hero, ...state.cards.alts].flatMap((card) => retentionsForCard(card))),
];

const retentionBoundsFor = (
  state: AssistantResponseState,
  nowMilliseconds: number,
): RetentionBounds | null => {
  const retentions = retentionsForState(state);
  if (retentions.length === 0) return null;

  for (const retention of retentions) {
    if (
      retention.retentionDecision !== 'allow' ||
      retention.policyStatus !== 'available' ||
      retention.displayPolicyStatus !== 'available'
    ) {
      return null;
    }
    if (
      earliestDeadline(
        [
          retention.sessionExpiresAt,
          retention.freshUntil,
          retention.displayUntil,
          retention.retentionUntil,
          retention.deletionScheduledAt,
        ],
        nowMilliseconds,
      ) === null
    ) {
      return null;
    }
  }

  const sessionExpiresAt = earliestDeadline(
    retentions.map((retention) => retention.sessionExpiresAt),
    nowMilliseconds,
  );
  const displayUntil = earliestDeadline(
    retentions.map((retention) => retention.displayUntil),
    nowMilliseconds,
  );
  const retentionUntil = earliestDeadline(
    retentions.map((retention) => retention.retentionUntil),
    nowMilliseconds,
  );
  const deletionScheduledAt = earliestDeadline(
    retentions.map((retention) => retention.deletionScheduledAt),
    nowMilliseconds,
  );
  if (sessionExpiresAt === null) return null;
  const sessionMilliseconds = millisecondsFor(sessionExpiresAt);
  if (sessionMilliseconds === null) return null;
  for (const deadline of [displayUntil, retentionUntil, deletionScheduledAt]) {
    if (deadline !== null && Date.parse(deadline) > sessionMilliseconds) return null;
  }
  return { sessionExpiresAt, displayUntil, retentionUntil, deletionScheduledAt };
};

const snapshotCandidateFor = (
  state: ReturnType<JourneyApiController['getState']>,
  localFirstObservedAt: string | null,
  nowValue: string,
): SnapshotCandidate | null => {
  const responseState = state.responseState;
  if (
    state.threadId === null ||
    responseState === null ||
    responseState.threadId !== state.threadId ||
    !Number.isSafeInteger(responseState.revision) ||
    responseState.revision < 1
  ) {
    return null;
  }
  const latestRecord = responseState.responseRecords[responseState.responseRecords.length - 1];
  if (latestRecord === undefined || latestRecord.revision !== responseState.revision) return null;
  const nowMilliseconds = millisecondsFor(nowValue);
  if (nowMilliseconds === null) return null;
  const bounds = retentionBoundsFor(responseState, nowMilliseconds);
  if (bounds === null) return null;

  if (localFirstObservedAt === null) return null;
  const startedMilliseconds = millisecondsFor(localFirstObservedAt);
  const sessionMilliseconds = millisecondsFor(bounds.sessionExpiresAt);
  if (
    startedMilliseconds === null ||
    sessionMilliseconds === null ||
    startedMilliseconds > nowMilliseconds ||
    startedMilliseconds >= sessionMilliseconds
  ) {
    return null;
  }

  // ThreadInput calls this field `createdAt`, but this adapter has no server
  // creation timestamp. It stores the local first-observed time only; the
  // public session expiry remains the upper bound below.
  const localCreatedAt = new Date(startedMilliseconds).toISOString();
  const updatedAt = new Date(nowMilliseconds).toISOString();
  return {
    thread: {
      id: state.threadId,
      createdAt: localCreatedAt,
      expiresAt: bounds.sessionExpiresAt,
    },
    snapshot: {
      threadId: state.threadId,
      responseId: latestRecord.responseId,
      revision: responseState.revision,
      sessionExpiresAt: bounds.sessionExpiresAt,
      displayUntil: bounds.displayUntil,
      retentionUntil: bounds.retentionUntil,
      deletionScheduledAt: bounds.deletionScheduledAt,
      updatedAt,
    },
  };
};

/**
 * Persists only reference metadata from the controller. The SQLite store owns
 * the actual retention and payload rules; this adapter never receives query,
 * location, card, or message values as persistence input.
 */
export const createLocalSessionPersistence = (
  options: LocalSessionPersistenceOptions,
): LocalSessionPersistence => {
  const now = options.now ?? (() => new Date().toISOString());
  /**
   * Local observation anchors are fixed for this service lifetime. They are
   * never presented as the server's thread creation time.
   */
  const localFirstObservedAt = new Map<string, string>();
  const savedThreadIds = new Set<string>();
  const attemptedRevisions = new Map<string, number>();
  let disposed = false;

  const firstObservedAtFor = (threadId: string | null, nowValue: string): string | null => {
    if (threadId === null) return null;
    const existing = localFirstObservedAt.get(threadId);
    if (existing !== undefined) return existing;
    const observedMilliseconds = millisecondsFor(nowValue);
    if (observedMilliseconds === null) return null;
    const observedAt = new Date(observedMilliseconds).toISOString();
    localFirstObservedAt.set(threadId, observedAt);
    return observedAt;
  };

  const capture = (): void => {
    if (disposed) return;
    try {
      const state = options.controller.getState();
      const nowValue = now();
      const candidate = snapshotCandidateFor(
        state,
        firstObservedAtFor(state.threadId, nowValue),
        nowValue,
      );
      if (candidate === null) return;
      const previousRevision = attemptedRevisions.get(candidate.thread.id);
      if (previousRevision !== undefined && candidate.snapshot.revision <= previousRevision) return;
      if (!savedThreadIds.has(candidate.thread.id)) {
        options.store.saveThread(candidate.thread);
        savedThreadIds.add(candidate.thread.id);
      }
      const written = options.store.writeSnapshot(candidate.snapshot);
      if (written) attemptedRevisions.set(candidate.thread.id, candidate.snapshot.revision);
    } catch {
      // Local persistence is auxiliary; controller state and its subscribers stay live.
    }
  };

  const unsubscribe = options.controller.subscribe(capture);
  capture();

  return {
    capture,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribe();
      } catch {
        // A host subscription failure must not surface through disposal.
      }
      localFirstObservedAt.clear();
      savedThreadIds.clear();
      attemptedRevisions.clear();
    },
  };
};

/** Adapts the same SQLite store to the controller's metadata-only restore port. */
export const createSqliteJourneyLocalRestore = (
  store: LocalSessionRestoreStore,
): JourneyLocalRestorePort => ({
  readSnapshot: (threadId) => store.readSnapshot(threadId),
});
