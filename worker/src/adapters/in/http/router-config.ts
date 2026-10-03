import type { ConversationHistoryNamespace } from '@worker/adapters/out/persistence/conversations/durable-conversation-store';
import type { ConversationPhotoReader } from '@worker/runtime/ports/conversation-photo';
import type { RateLimiter } from '@worker/security/rate-limit';
import type { AuthConfig } from '@worker/adapters/in/http/auth';
import type { BoundaryFailure } from '@worker/adapters/in/http/errors';
import type { HandlerDependencies } from '@worker/adapters/in/http/handler';
import type { AppIntegrityGate } from '@worker/adapters/in/http/app-integrity-gate';

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 32 * 1024;

export type ResourceKind = 'thread' | 'saved_reference' | 'photo';

export type ResourceReference = {
  readonly kind: ResourceKind;
  readonly id: string;
};

export type ResourceScopeDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly failure: BoundaryFailure };

export interface ResourceScopeAuthorizer {
  authorize(input: {
    readonly ownerScopeRef: string;
    readonly resource: ResourceReference;
    /** Caller-side cancellation; an underlying RPC may not support abort. */
    readonly signal?: AbortSignal;
  }): Promise<ResourceScopeDecision>;
}

export type HttpRouterConfig = {
  readonly conversationPhotos?: ConversationPhotoReader;
  readonly conversationPhotosRateLimiter?: RateLimiter;
  readonly conversations?: ConversationHistoryNamespace;
  readonly conversationReadsRateLimiter?: RateLimiter;
  readonly auth: AuthConfig;
  readonly handlers: HandlerDependencies;
  readonly ownership: ResourceScopeAuthorizer;
  /** Optional external-distribution gate; missing verifier state must fail closed in required mode. */
  readonly appIntegrity?: AppIntegrityGate;
  readonly now: () => string;
  readonly maxBodyBytes?: number;
};
