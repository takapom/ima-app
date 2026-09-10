import type {
  JourneyApiController,
  JourneyApiControllerState,
} from '../services/api/journey-controller';

export type JourneyHistoryController = {
  readonly restoreLocal: (threadId: string) => Promise<unknown>;
  readonly readThread: (threadId: string) => Promise<unknown>;
  readonly getState: () => Pick<JourneyApiControllerState, 'threadId'>;
};

export type JourneyControllerCleanup = Pick<JourneyApiController, 'cancelPending'> & {
  readonly getState: () => Pick<JourneyApiControllerState, 'status'>;
};

/** Invalidates in-flight work without permanently disposing a host-owned controller. */
export const releaseJourneyApiController = (controller: JourneyControllerCleanup): void => {
  const status = controller.getState().status;
  if (
    status === 'creating' ||
    status === 'pending' ||
    status === 'cancelling' ||
    status === 'reading' ||
    status === 'replaying'
  ) {
    controller.cancelPending();
  }
};

export const submissionScopeMatches = (
  startedThreadId: string | null,
  currentThreadId: string | null,
): boolean => startedThreadId === currentThreadId;

export const operationStillCurrent = (
  startedGeneration: number,
  currentGeneration: number,
  startedThreadId: string | null,
  currentThreadId: string | null,
): boolean =>
  startedGeneration === currentGeneration &&
  submissionScopeMatches(startedThreadId, currentThreadId);

/**
 * Runs local restore followed by server read only while the operation still
 * owns the selected thread. The controller also rejects late responses; this
 * boundary prevents the hook from continuing an invalidated operation.
 */
export const restoreThenReadIfCurrent = async (
  controller: JourneyHistoryController,
  threadId: string,
  isCurrent: () => boolean,
): Promise<boolean> => {
  await controller.restoreLocal(threadId);
  if (!isCurrent() || controller.getState().threadId !== threadId) return false;
  await controller.readThread(threadId);
  return isCurrent() && controller.getState().threadId === threadId;
};

export const awaitRetryIfCurrent = async <T>(
  startedGeneration: number,
  startedThreadId: string | null,
  current: () => { readonly generation: number; readonly threadId: string | null },
  retry: () => Promise<T>,
): Promise<{ readonly current: true; readonly result: T } | { readonly current: false }> => {
  const result = await retry();
  const next = current();
  return operationStillCurrent(startedGeneration, next.generation, startedThreadId, next.threadId)
    ? { current: true, result }
    : { current: false };
};
