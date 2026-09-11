import * as v from 'valibot';
import type { UIMessage } from 'ai';
import type { ClockPort, RetentionMetadata } from '@ima/core';
import { IsoTimestampSchema, OpaqueIdSchema, ThreadIdSchema, TurnIdSchema } from '@ima/core';
import { RetentionMetadataSchema } from '@ima/core';

// The envelope accepts runtime extensions so the sanitizer can remove them.
export const RetentionMessageMetadataSchema = v.object({
  retention: RetentionMetadataSchema,
  ownerScopeRef: OpaqueIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
});

export type RetentionMessageMetadata = v.InferOutput<typeof RetentionMessageMetadataSchema>;
/** SDK UIMessage leaves metadata optional; persisted server messages do not. */
export type RetentionMessage = Omit<UIMessage<RetentionMessageMetadata>, 'metadata'> & {
  metadata: RetentionMessageMetadata;
};
export type RetentionClock = Pick<ClockPort, 'now'>;

export type RetentionSanitizerContext = {
  clock: RetentionClock;
  ownerScopeRef: string;
  threadId: string;
};

export function retentionExpiryAt(metadata: RetentionMessageMetadata): string {
  return metadata.retention.retentionUntil ?? metadata.retention.sessionExpiresAt;
}

export function isRetentionExpired(metadata: RetentionMessageMetadata, now: string): boolean {
  const parsedNow = v.safeParse(IsoTimestampSchema, now);
  if (!parsedNow.success) throw new Error('RETENTION_CLOCK_INVALID');
  return Date.parse(parsedNow.output) >= Date.parse(retentionExpiryAt(metadata));
}

export function parseRetentionMessage(message: UIMessage): RetentionMessage | undefined {
  const parsedId = v.safeParse(OpaqueIdSchema, message.id);
  if (!parsedId.success) return undefined;
  if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') {
    return undefined;
  }
  if (!Array.isArray(message.parts)) return undefined;
  const parsed = v.safeParse(RetentionMessageMetadataSchema, message.metadata);
  if (!parsed.success) return undefined;
  return {
    id: parsedId.output,
    role: message.role,
    parts: message.parts,
    metadata: parsed.output,
  };
}

/**
 * Keep the SDK hook small: it validates the harness-owned envelope, then
 * performs one message decision. The SDK remains responsible for iterating
 * and upserting through its public persistMessages API.
 */
export function sanitizeMessageForPersistence(
  message: UIMessage,
  context: RetentionSanitizerContext,
): RetentionMessage {
  const ownerScopeRef = v.parse(OpaqueIdSchema, context.ownerScopeRef);
  const threadId = v.parse(ThreadIdSchema, context.threadId);
  const retained = parseRetentionMessage(message);
  if (retained === undefined) throw new Error('RETENTION_METADATA_REQUIRED');
  if (retained.metadata.ownerScopeRef !== ownerScopeRef) {
    throw new Error('RETENTION_OWNER_MISMATCH');
  }
  if (retained.metadata.threadId !== threadId) {
    throw new Error('RETENTION_THREAD_MISMATCH');
  }
  return sanitizeRetentionMessage(retained, context);
}

export function sanitizeRetentionMessage(
  message: RetentionMessage,
  context: RetentionSanitizerContext,
): RetentionMessage {
  const retention = message.metadata.retention;
  const policyWithheld =
    retention.retentionDecision !== 'allow' ||
    retention.policyStatus !== 'available' ||
    retention.restoreMode === 'reference_only';
  if (!policyWithheld && !isRetentionExpired(message.metadata, context.clock.now())) {
    return {
      id: message.id,
      role: message.role,
      parts: persistenceParts(message),
      metadata: persistenceMetadata(message),
    };
  }
  return referenceOnlyMessage(message);
}

function persistenceParts(message: RetentionMessage): RetentionMessage['parts'] {
  return message.parts.filter((part) => !part.type.startsWith('data-'));
}

function persistenceMetadata(message: RetentionMessage): RetentionMessageMetadata {
  const { retention, ownerScopeRef, threadId, turnId } = message.metadata;
  return { retention, ownerScopeRef, threadId, turnId };
}

export function referenceOnlyMessage(message: RetentionMessage): RetentionMessage {
  const source = message.metadata.retention;
  const retention: RetentionMetadata = {
    retentionDecision: source.retentionDecision,
    retentionMode: source.retentionMode,
    sessionExpiresAt: source.sessionExpiresAt,
    freshUntil: source.freshUntil,
    displayUntil: source.displayUntil,
    retentionUntil: source.retentionUntil,
    deletionScheduledAt: source.deletionScheduledAt,
    attribution: source.attribution,
    restoreMode: 'reference_only',
    policyStatus: source.policyStatus,
    displayPolicyStatus: source.displayPolicyStatus,
  };
  return {
    id: message.id,
    role: message.role,
    parts: [{ type: 'text', text: '[withheld]' }],
    metadata: {
      retention,
      ownerScopeRef: message.metadata.ownerScopeRef,
      threadId: message.metadata.threadId,
      turnId: message.metadata.turnId,
    },
  };
}
