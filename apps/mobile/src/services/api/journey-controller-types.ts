import type {
  CreateThreadRequest,
  CreateThreadResponse,
  LifecycleCommand,
  SearchRequest,
  SearchResponse,
  ThreadReadResponse,
  ThreadTurnRequest,
} from '@ima/contracts';
import type { AssistantResponseState } from '../../state/assistant-response';
import type {
  ApiError,
  ApiRequestOptions,
  ApiResult,
  JourneyApiClient,
  LifecycleResponse,
} from './api';
import type { ApiOperationToken } from './request-gate';

export type JourneyLocalSnapshot = {
  readonly threadId: string;
  readonly responseId: string;
  readonly revision: number;
  readonly restoreMode: 'reference_only';
  readonly updatedAt: string;
  readonly sessionExpiresAt: string;
  readonly displayUntil: string | null;
  readonly retentionUntil: string | null;
  readonly deletionScheduledAt: string | null;
  readonly needsRefetch: boolean;
};

export type JourneyLocalRestorePort = {
  readonly readSnapshot: (
    threadId: string,
  ) => JourneyLocalSnapshot | null | Promise<JourneyLocalSnapshot | null>;
};

export type JourneyLocalRestoreResult =
  | { readonly status: 'restored'; readonly snapshot: JourneyLocalSnapshot }
  | { readonly status: 'empty' }
  | { readonly status: 'unavailable'; readonly reason: 'not_configured' | 'read_failed' };

export type JourneyControllerStatus =
  'idle' | 'creating' | 'pending' | 'cancelling' | 'reading' | 'replaying' | 'error' | 'cancelled';

export type JourneyApiControllerState = {
  readonly mode: JourneyApiClient['mode'];
  readonly threadId: string | null;
  readonly responseState: AssistantResponseState | null;
  /** A local reference is metadata only; it never supplies response or provider payload. */
  readonly localSnapshot: JourneyLocalSnapshot | null;
  readonly activeTurnId: string | null;
  readonly status: JourneyControllerStatus;
  readonly error: ApiError | null;
  readonly lastRequestId: string | null;
};

export type JourneyApiController = {
  readonly getState: () => JourneyApiControllerState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly createThread: (
    input: CreateThreadRequest,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<CreateThreadResponse>>;
  readonly search: (
    input: SearchRequest,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<SearchResponse>>;
  readonly turn: (
    threadId: string,
    input: ThreadTurnRequest,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<SearchResponse>>;
  readonly retry: () => Promise<ApiResult<CreateThreadResponse> | ApiResult<SearchResponse>>;
  readonly cancel: (
    threadId: string,
    input: LifecycleCommand,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<LifecycleResponse>>;
  readonly readThread: (
    threadId: string,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<ThreadReadResponse>>;
  readonly replayThread: (
    threadId: string,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<ThreadReadResponse>>;
  readonly restoreLocal: (threadId: string) => Promise<JourneyLocalRestoreResult>;
  /** Cancels local work before a server thread exists. */
  readonly cancelPending: () => void;
  readonly reset: () => void;
  readonly dispose: () => void;
};

export type JourneyApiControllerOptions = {
  readonly api: JourneyApiClient;
  readonly localRestore?: JourneyLocalRestorePort;
  /** Service-boundary clock used to reject a reference that expires during restore. */
  readonly clock?: () => string;
};

export type ResponseOperation =
  | { readonly kind: 'search'; readonly threadId: string; readonly input: SearchRequest }
  | { readonly kind: 'turn'; readonly threadId: string; readonly input: ThreadTurnRequest };

export type ActiveResponseOperation = {
  readonly operation: ResponseOperation;
  readonly token: ApiOperationToken;
  readonly abort: AbortController;
  readonly epoch: number;
  readonly promise: Promise<ApiResult<SearchResponse>>;
};

export type RetryableResponseOperation = {
  readonly operation: ResponseOperation;
  readonly token: ApiOperationToken;
};

export type LifecycleResult = ApiResult<LifecycleResponse>;
