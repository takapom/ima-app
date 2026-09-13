import type { AssistantResponseState } from '../../state/assistant-response';
import {
  advanceAssistantRevision,
  createAssistantResponseState,
} from '../../state/assistant-response';
import type { ApiError, ApiResult } from './api';
import type { JourneyLocalSnapshot } from './journey-controller-types';

export const failure = <T>(requestId: string, route: string, issue: string): ApiResult<T> => ({
  ok: false,
  requestId,
  error: { kind: 'contract', route, issues: [issue], status: null },
});

export const aborted = <T>(requestId: string): ApiResult<T> => ({
  ok: false,
  requestId,
  error: { kind: 'aborted' },
});

export const offline = <T>(requestId: string): ApiResult<T> => ({
  ok: false,
  requestId,
  error: { kind: 'offline' },
});

export const requestIdOf = (input: { readonly requestId: string }): string => input.requestId;

export const validOpaqueId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);

export const validLocalSnapshot = (
  snapshot: JourneyLocalSnapshot,
  threadId: string,
  now: string,
): boolean =>
  snapshot.threadId === threadId &&
  validOpaqueId(snapshot.threadId) &&
  validOpaqueId(snapshot.responseId) &&
  Number.isSafeInteger(snapshot.revision) &&
  snapshot.revision > 0 &&
  snapshot.restoreMode === 'reference_only' &&
  Number.isFinite(Date.parse(now)) &&
  [
    snapshot.sessionExpiresAt,
    snapshot.displayUntil,
    snapshot.retentionUntil,
    snapshot.deletionScheduledAt,
  ].every((deadline) => deadline === null || Number.isFinite(Date.parse(deadline))) &&
  [
    snapshot.sessionExpiresAt,
    snapshot.displayUntil,
    snapshot.retentionUntil,
    snapshot.deletionScheduledAt,
  ].every((deadline) => deadline === null || Date.parse(now) < Date.parse(deadline));

export const stateForThread = (threadId: string, revision = 0): AssistantResponseState =>
  advanceAssistantRevision(createAssistantResponseState(threadId), revision);

export const latestTurnId = (state: AssistantResponseState): string | null => {
  const record = state.responseRecords[state.responseRecords.length - 1];
  return record?.turnId ?? null;
};

export const controllerError = (route: string, issue: string): ApiError => ({
  kind: 'contract',
  route,
  issues: [issue],
  status: null,
});
