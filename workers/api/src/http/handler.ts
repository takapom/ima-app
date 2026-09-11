import type * as v from 'valibot';
import type {
  CreateThreadRequest,
  CreateThreadResponse,
  EventsRequest,
  PhotoBinaryResponse,
  SearchRequest,
  SearchResponse,
  ThreadReadResponse,
  ThreadTurnRequest,
  LifecycleCommandSchema,
  LifecycleResponseSchema,
  PhotoPathSchema,
  SavedReferenceCreateRequest,
  SavedReferenceCreateResponse,
  SavedReferenceDeleteRequest,
  SavedReferencePathSchema,
  SavedReferenceResponseSchema,
  ThreadPathSchema,
} from '@ima/contracts';
import type { CancellationToken } from '@ima/core';

export type LifecycleCommand = v.InferOutput<typeof LifecycleCommandSchema>;
export type LifecycleResponse = v.InferOutput<typeof LifecycleResponseSchema>;
export type PhotoPath = v.InferOutput<typeof PhotoPathSchema>;
export type SavedReferenceCreateInput = SavedReferenceCreateRequest;
export type SavedReferenceDeleteInput = SavedReferenceDeleteRequest;
export type SavedReferenceCreateOutput = SavedReferenceCreateResponse;
export type SavedReferencePath = v.InferOutput<typeof SavedReferencePathSchema>;
export type SavedReferenceResponse = v.InferOutput<typeof SavedReferenceResponseSchema>;
export type ThreadPath = v.InferOutput<typeof ThreadPathSchema>;

export type HandlerContext = {
  readonly requestId: string;
  readonly ownerScopeRef: string;
  readonly deviceId: string;
  readonly appVersion: string;
  readonly serverNow: string;
  readonly cancellation: CancellationToken;
  /** Worker-local HTTP cancellation; never serialize this signal into a DO RPC or Core Port. */
  readonly signal: AbortSignal;
};

/** A Worker adapter may leave the bounded provider body as a stream until Response consumes it. */
export type WorkerPhotoBinaryResponse = Omit<PhotoBinaryResponse, 'body'> & {
  readonly body: Uint8Array | ReadableStream<Uint8Array>;
};

export type ApplicationOperation =
  | { readonly kind: 'create_thread'; readonly input: CreateThreadRequest }
  | { readonly kind: 'search'; readonly input: SearchRequest }
  | { readonly kind: 'turn'; readonly path: ThreadPath; readonly input: ThreadTurnRequest }
  | { readonly kind: 'read_thread'; readonly path: ThreadPath }
  | { readonly kind: 'replay_thread'; readonly path: ThreadPath }
  | {
      readonly kind: 'lifecycle';
      readonly action: 'cancel' | 'resume' | 'restart' | 'end';
      readonly path: ThreadPath;
      readonly input: LifecycleCommand;
    }
  | {
      readonly kind: 'delete_thread';
      readonly path: ThreadPath;
      readonly input: LifecycleCommand;
    }
  | { readonly kind: 'saved_reference_refresh'; readonly path: SavedReferencePath }
  | {
      readonly kind: 'saved_reference_create';
      readonly path: ThreadPath;
      readonly input: SavedReferenceCreateInput;
    }
  | {
      readonly kind: 'saved_reference_delete';
      readonly path: SavedReferencePath;
      readonly input: SavedReferenceDeleteInput;
    };

export type ApplicationResult =
  | { readonly kind: 'create_thread'; readonly response: CreateThreadResponse }
  | { readonly kind: 'search'; readonly response: SearchResponse }
  | { readonly kind: 'turn'; readonly response: SearchResponse }
  | { readonly kind: 'read_thread'; readonly response: ThreadReadResponse }
  | { readonly kind: 'replay_thread'; readonly response: ThreadReadResponse }
  | { readonly kind: 'lifecycle'; readonly response: LifecycleResponse }
  | { readonly kind: 'delete_thread'; readonly response: null }
  | { readonly kind: 'saved_reference_refresh'; readonly response: SavedReferenceResponse }
  | { readonly kind: 'saved_reference_create'; readonly response: SavedReferenceCreateOutput }
  | { readonly kind: 'saved_reference_delete'; readonly response: null };

/** Worker-owned adapter boundary; HTTP/SDK/Env objects never cross into the application. */
export interface ApplicationHandler {
  handle(operation: ApplicationOperation, context: HandlerContext): Promise<ApplicationResult>;
}

export interface PhotoBodyHandler {
  /** Optional token/scope check used when the handler owns the photo resource boundary. */
  authorize?(path: PhotoPath, context: HandlerContext): Promise<void>;
  read(path: PhotoPath, context: HandlerContext): Promise<WorkerPhotoBinaryResponse>;
}

export interface EventsSink {
  accept(input: EventsRequest, context: HandlerContext): Promise<void>;
}

export type RateLimitRequest = {
  readonly route: string;
  readonly deviceId: string;
  readonly ownerScopeRef: string;
};

export type RateLimitResult = {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number | null;
};

export interface RateLimiter {
  check(input: RateLimitRequest): Promise<RateLimitResult>;
}

export type HandlerDependencies = {
  readonly application: ApplicationHandler;
  readonly photo: PhotoBodyHandler;
  readonly events: EventsSink;
  readonly rateLimiter: RateLimiter;
};
