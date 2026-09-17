import type { CreateThreadResponse, SearchResponse } from '@ima/contracts';
import type {
  JourneyApiController,
  JourneyApiControllerState,
} from '@mobile/services/thread-session/journey-controller';
import type { ApiResult } from '@mobile/services/api/api';

export type JourneyApiRetryResult = ApiResult<CreateThreadResponse> | ApiResult<SearchResponse>;

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

/** Completes a failed create and starts its original search only in the same operation scope. */
export const retryCreatedThreadThenSearchIfCurrent = async (
  startedGeneration: number,
  current: () => { readonly generation: number; readonly threadId: string | null },
  retryCreate: () => Promise<JourneyApiRetryResult>,
  search: (created: CreateThreadResponse) => Promise<ApiResult<SearchResponse>>,
): Promise<
  { readonly current: true; readonly result: JourneyApiRetryResult } | { readonly current: false }
> => {
  const created = await retryCreate();
  const afterCreate = current();
  if (afterCreate.generation !== startedGeneration) return { current: false };
  if (!created.ok) return { current: true, result: created };
  if (!('threadId' in created.data) || afterCreate.threadId !== created.data.threadId) {
    return { current: false };
  }
  const result = await search(created.data);
  const afterSearch = current();
  return afterSearch.generation === startedGeneration &&
    afterSearch.threadId === created.data.threadId
    ? { current: true, result }
    : { current: false };
};
