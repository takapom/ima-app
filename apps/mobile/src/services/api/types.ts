import type {
  CreateThreadRequest,
  CreateThreadResponse,
  LifecycleCommand,
  SearchRequest,
  SearchResponse,
  SavedReferenceCreateRequest,
  SavedReferenceCreateResponse,
  SavedReferenceDeleteRequest,
  ThreadReadResponse,
  ThreadTurnRequest,
  PublicError,
} from '@ima/contracts';
import type { SavedReferenceRefreshResponse } from './saved-reference-refresh';

export type ApiMode = 'fixture' | 'live';

/** Credentials are supplied by the host; this service never chooses a storage SDK. */
export type ApiCredentials = {
  readonly appToken: string;
  readonly deviceId: string;
  readonly ownerCredential: string;
};

export type ApiCredentialProvider =
  ApiCredentials | (() => ApiCredentials | Promise<ApiCredentials>);

export type ApiFetch = typeof fetch;

export type ApiRequestOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export type ApiClientOptions = {
  readonly baseUrl: string;
  readonly mode: ApiMode;
  readonly appVersion: string;
  readonly credentials: ApiCredentialProvider;
  readonly requestIdFactory: () => string;
  readonly fetchImpl?: ApiFetch;
  readonly timeoutMs?: number;
};

export type ApiError =
  | {
      readonly kind: 'configuration';
      readonly reason: 'invalid_base_url' | 'invalid_timeout' | 'invalid_request_id';
    }
  | {
      readonly kind: 'credentials';
      readonly reason: 'missing' | 'invalid' | 'unavailable';
    }
  | {
      readonly kind: 'aborted' | 'timeout' | 'offline';
    }
  | {
      readonly kind: 'http';
      readonly status: number;
      readonly publicError: PublicError;
      readonly retryAfterSeconds: number | null;
    }
  | {
      readonly kind: 'contract';
      readonly route: string;
      readonly issues: readonly string[];
      readonly status: number | null;
    };

export type ApiSuccess<T> = {
  readonly ok: true;
  readonly data: T;
  readonly requestId: string;
};

export type ApiFailure = {
  readonly ok: false;
  readonly error: ApiError;
  readonly requestId: string;
};

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export type JourneyApiClient = {
  readonly mode: ApiMode;
  readonly search: (
    input: SearchRequest,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<SearchResponse>>;
  readonly createThread: (
    input: CreateThreadRequest,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<CreateThreadResponse>>;
  readonly turn: (
    threadId: string,
    input: ThreadTurnRequest,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<SearchResponse>>;
  readonly readThread: (
    threadId: string,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<ThreadReadResponse>>;
  readonly replayThread: (
    threadId: string,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<ThreadReadResponse>>;
  readonly lifecycle: (
    action: 'cancel' | 'resume' | 'restart' | 'end',
    threadId: string,
    input: LifecycleCommand,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<LifecycleResponse>>;
  readonly deleteThread: (
    threadId: string,
    input: LifecycleCommand,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<null>>;
  readonly createSavedReference: (
    threadId: string,
    input: SavedReferenceCreateRequest,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<SavedReferenceCreateResponse>>;
  readonly deleteSavedReference: (
    savedPlaceRef: string,
    input: SavedReferenceDeleteRequest,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<null>>;
  readonly refreshSavedReference: (
    savedPlaceRef: string,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<SavedReferenceRefreshResponse>>;
};

export type LifecycleResponse = {
  readonly schemaVersion: 'v1';
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly revision: number;
  readonly state: 'active' | 'cancelled' | 'ended' | 'restarted' | 'resumed';
};
