import * as v from 'valibot';
import type { JSONValue, UIMessage } from 'ai';
import type { RetentionMetadata } from '@ima/core';
import {
  IsoTimestampSchema,
  OpaqueIdSchema,
  RetentionMetadataSchema,
  ThreadIdSchema,
  TurnIdSchema,
} from '@ima/core';
import {
  cloneRuntimeJsonValue,
  isRuntimeJsonValue,
} from '@worker/runtime/retention/runtime-retention-json';

export {
  cloneRuntimeJsonValue,
  isRuntimeJsonValue,
} from '@worker/runtime/retention/runtime-retention-json';

export const RUNTIME_RETENTION_WITHHELD = '[withheld]' as const;

export const RUNTIME_RETENTION_TOOL_NAMES = [
  'search_places',
  'get_place_details',
  'submit_cards',
] as const;
export type RuntimeRetentionToolName = (typeof RUNTIME_RETENTION_TOOL_NAMES)[number];

export function isRuntimeRetentionToolName(value: string): value is RuntimeRetentionToolName {
  return RUNTIME_RETENTION_TOOL_NAMES.some((name) => name === value);
}

/** Schema-shaped placeholders keep the AI SDK step parser valid without persisting arguments. */
export function redactedRuntimeToolInput(toolName: RuntimeRetentionToolName): JSONValue {
  switch (toolName) {
    case 'search_places':
      return {
        input: {
          mode: 'search',
          query: 'WITHHELD',
          area: { kind: 'named_area', name: 'WITHHELD' },
          openNow: false,
          limit: 1,
          excludeCandidateIds: [],
        },
        metadata: {},
      };
    case 'get_place_details':
      return {
        input: {
          requests: [{ candidateId: 'candidate-withheld', fields: ['identity'] }],
          freshness: 'reuse_valid',
        },
        metadata: {},
      };
    case 'submit_cards':
      return {
        input: {
          message: [{ text: 'WITHHELD', evidenceIds: [], basis: 'inference' }],
          hero: {
            candidateId: 'candidate-withheld',
            evidenceIds: [],
            why: { text: 'WITHHELD', evidenceIds: [], basis: 'inference' },
          },
          alts: [],
        },
        metadata: {},
      };
  }
}

export type RuntimeRetentionMessageMetadata = {
  readonly retention: RetentionMetadata;
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
};

export const RuntimeRetentionMessageMetadataSchema = v.strictObject({
  retention: RetentionMetadataSchema,
  ownerScopeRef: OpaqueIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
});

export type RuntimeRetentionMessage = Omit<
  UIMessage<RuntimeRetentionMessageMetadata>,
  'metadata'
> & {
  metadata: RuntimeRetentionMessageMetadata;
};

export type RuntimeRetentionContext = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly retention: RetentionMetadata;
};

export type RuntimeRetentionEphemeralScope = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly retention: RetentionMetadata;
};

export type RuntimeRetentionScopeIdentity = Pick<
  RuntimeRetentionEphemeralScope,
  'ownerScopeRef' | 'threadId' | 'turnId'
>;

export const RuntimeRetentionScopeIdentitySchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
});

export const RuntimeRetentionEphemeralScopeSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  retention: RetentionMetadataSchema,
});

export type RuntimeRetentionEphemeralToolCall = {
  readonly toolCallId: string;
  readonly toolName: RuntimeRetentionToolName;
  readonly input: JSONValue;
  readonly scope: RuntimeRetentionEphemeralScope;
};

export type RuntimeRetentionEphemeralToolResult = {
  readonly toolCallId: string;
  readonly toolName: RuntimeRetentionToolName;
  readonly output: JSONValue;
  readonly localFreshUntil: string;
  readonly localExpiresAt: string;
  readonly scope: RuntimeRetentionEphemeralScope;
};

export type RuntimeRetentionReplayReference = {
  readonly responseId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly restoreMode: 'reference_only';
  readonly body: null;
  readonly bodyResent: false;
  readonly retention: RetentionMetadata;
};

export type RuntimeRetentionErrorCode =
  | 'RETENTION_CONTEXT_INVALID'
  | 'RETENTION_METADATA_INVALID'
  | 'RETENTION_OWNER_MISMATCH'
  | 'RETENTION_THREAD_MISMATCH'
  | 'RETENTION_CLOCK_INVALID'
  | 'RETENTION_PART_INVALID'
  | 'RETENTION_EPHEMERAL_INVALID'
  | 'RETENTION_EPHEMERAL_TURN_MISMATCH';

export class RuntimeRetentionError extends Error {
  readonly code: RuntimeRetentionErrorCode;

  constructor(code: RuntimeRetentionErrorCode) {
    super(`runtime retention denied: ${code}`);
    this.name = 'RuntimeRetentionError';
    this.code = code;
  }
}

const validRole = (value: string): value is RuntimeRetentionMessage['role'] =>
  value === 'system' || value === 'user' || value === 'assistant';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parsedContext(context: RuntimeRetentionContext): RuntimeRetentionContext {
  const parsed = v.safeParse(RuntimeRetentionMessageMetadataSchema, {
    retention: context.retention,
    ownerScopeRef: context.ownerScopeRef,
    threadId: context.threadId,
    turnId: context.turnId,
  });
  if (!parsed.success) throw new RuntimeRetentionError('RETENTION_CONTEXT_INVALID');
  return parsed.output;
}

function parsedNow(now: string): number {
  const parsed = v.safeParse(IsoTimestampSchema, now);
  if (!parsed.success) throw new RuntimeRetentionError('RETENTION_CLOCK_INVALID');
  const value = Date.parse(parsed.output);
  if (!Number.isFinite(value)) throw new RuntimeRetentionError('RETENTION_CLOCK_INVALID');
  return value;
}

function retentionBoundaries(retention: RetentionMetadata): readonly string[] {
  return [
    retention.sessionExpiresAt,
    retention.freshUntil,
    retention.displayUntil,
    retention.retentionUntil,
    retention.deletionScheduledAt,
  ].filter((value): value is string => value !== null);
}

/** Every finite policy boundary is checked at the point of model projection. */
export function isRuntimeRetentionWindowOpen(retention: RetentionMetadata, now: string): boolean {
  const parsedRetention = v.safeParse(RetentionMetadataSchema, retention);
  const parsedClock = v.safeParse(IsoTimestampSchema, now);
  if (!parsedRetention.success || !parsedClock.success) return false;
  if (
    parsedRetention.output.retentionDecision !== 'allow' ||
    parsedRetention.output.policyStatus !== 'available' ||
    parsedRetention.output.displayPolicyStatus !== 'available'
  ) {
    return false;
  }
  const nowMs = Date.parse(parsedClock.output);
  if (!Number.isFinite(nowMs)) return false;
  return retentionBoundaries(parsedRetention.output).every((boundary) => {
    const boundaryMs = Date.parse(boundary);
    return Number.isFinite(boundaryMs) && nowMs < boundaryMs;
  });
}

function bodyMayPersist(retention: RetentionMetadata, now: string): boolean {
  if (
    retention.retentionDecision !== 'allow' ||
    retention.policyStatus !== 'available' ||
    retention.displayPolicyStatus !== 'available' ||
    retention.restoreMode !== 'full'
  ) {
    return false;
  }
  const nowMs = parsedNow(now);
  const bodyUntil = retention.retentionUntil ?? retention.sessionExpiresAt;
  const bodyUntilMs = Date.parse(bodyUntil);
  const deletionMs =
    retention.deletionScheduledAt === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(retention.deletionScheduledAt);
  return Number.isFinite(bodyUntilMs) && nowMs < bodyUntilMs && nowMs < deletionMs;
}

export function parseRuntimeRetentionMessage(
  message: UIMessage,
): RuntimeRetentionMessage | undefined {
  if (!validRole(message.role) || !Array.isArray(message.parts)) return undefined;
  const parsedId = v.safeParse(OpaqueIdSchema, message.id);
  const parsedMetadata = v.safeParse(RuntimeRetentionMessageMetadataSchema, message.metadata);
  if (!parsedId.success || !parsedMetadata.success) return undefined;
  return {
    id: parsedId.output,
    role: message.role,
    parts: message.parts,
    metadata: parsedMetadata.output,
  };
}

/** Discards client metadata and creates a server-owned envelope for a new turn message. */
export function attachRuntimeRetentionContext(
  message: UIMessage,
  context: RuntimeRetentionContext,
): RuntimeRetentionMessage {
  const parsed = parsedContext(context);
  const id = v.safeParse(OpaqueIdSchema, message.id);
  if (!id.success || !validRole(message.role) || !Array.isArray(message.parts)) {
    throw new RuntimeRetentionError('RETENTION_METADATA_INVALID');
  }
  return {
    id: id.output,
    role: message.role,
    parts: message.parts,
    metadata: {
      retention: parsed.retention,
      ownerScopeRef: parsed.ownerScopeRef,
      threadId: parsed.threadId,
      turnId: parsed.turnId,
    },
  };
}

function resolveRuntimeRetentionMessage(
  message: UIMessage,
  context: RuntimeRetentionContext,
): RuntimeRetentionMessage {
  if (message.metadata === undefined) return attachRuntimeRetentionContext(message, context);
  const parsed = parseRuntimeRetentionMessage(message);
  if (parsed === undefined) throw new RuntimeRetentionError('RETENTION_METADATA_INVALID');
  const owner = v.safeParse(OpaqueIdSchema, context.ownerScopeRef);
  const thread = v.safeParse(ThreadIdSchema, context.threadId);
  if (!owner.success || !thread.success)
    throw new RuntimeRetentionError('RETENTION_CONTEXT_INVALID');
  if (parsed.metadata.ownerScopeRef !== owner.output) {
    throw new RuntimeRetentionError('RETENTION_OWNER_MISMATCH');
  }
  if (parsed.metadata.threadId !== thread.output) {
    throw new RuntimeRetentionError('RETENTION_THREAD_MISMATCH');
  }
  return parsed;
}

function persistenceParts(parts: UIMessage['parts']): UIMessage['parts'] {
  const safe: UIMessage['parts'] = [];
  for (const part of parts) {
    if (!isRecord(part) || typeof part.type !== 'string') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      safe.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'step-start') safe.push({ type: 'step-start' });
  }
  return safe;
}

function persistenceMetadata(
  metadata: RuntimeRetentionMessageMetadata,
): RuntimeRetentionMessageMetadata {
  return {
    retention: metadata.retention,
    ownerScopeRef: metadata.ownerScopeRef,
    threadId: metadata.threadId,
    turnId: metadata.turnId,
  };
}

export function referenceOnlyRuntimeMessage(
  message: RuntimeRetentionMessage,
): RuntimeRetentionMessage {
  const retention = v.parse(RetentionMetadataSchema, message.metadata.retention);
  return {
    id: message.id,
    role: message.role,
    parts: [{ type: 'text', text: RUNTIME_RETENTION_WITHHELD }],
    metadata: {
      ...persistenceMetadata(message.metadata),
      retention: { ...retention, restoreMode: 'reference_only' },
    },
  };
}

/** Structural allowlist for the payload passed to a public SDK persistence method. */
export function sanitizeRuntimeMessageForPersistence(
  message: UIMessage,
  context: RuntimeRetentionContext,
  now: string,
): RuntimeRetentionMessage {
  const retained = resolveRuntimeRetentionMessage(message, context);
  const safeMetadata = persistenceMetadata(retained.metadata);
  if (!bodyMayPersist(safeMetadata.retention, now)) {
    return referenceOnlyRuntimeMessage({ ...retained, metadata: safeMetadata });
  }
  const parts = persistenceParts(retained.parts);
  if (parts.length === 0) {
    return referenceOnlyRuntimeMessage({ ...retained, metadata: safeMetadata });
  }
  return {
    id: retained.id,
    role: retained.role,
    parts,
    metadata: safeMetadata,
  };
}

export function sanitizeRuntimeMessagesForPersistence(
  messages: readonly UIMessage[],
  context: RuntimeRetentionContext,
  now: string,
): RuntimeRetentionMessage[] {
  return messages.map((message) => sanitizeRuntimeMessageForPersistence(message, context, now));
}

/** Compaction has no reliable one-to-one provenance, so its summary is always a reference. */
export function sanitizeRuntimeCompactionSummary(_summary: unknown): string {
  return RUNTIME_RETENTION_WITHHELD;
}

export function makeRuntimeRetentionReplayReference(
  responseId: string,
  revision: number,
  context: RuntimeRetentionContext,
): RuntimeRetentionReplayReference {
  const parsed = parsedContext(context);
  const parsedResponseId = v.safeParse(OpaqueIdSchema, responseId);
  if (!parsedResponseId.success || !Number.isSafeInteger(revision) || revision < 1) {
    throw new RuntimeRetentionError('RETENTION_CONTEXT_INVALID');
  }
  return {
    responseId: parsedResponseId.output,
    turnId: parsed.turnId,
    revision,
    restoreMode: 'reference_only',
    body: null,
    bodyResent: false,
    retention: parsed.retention,
  };
}

export function captureRuntimeEphemeralToolCall(
  current: RuntimeRetentionEphemeralScope,
  entry: Omit<RuntimeRetentionEphemeralToolCall, 'scope'>,
): RuntimeRetentionEphemeralToolCall {
  const parsedScope = v.safeParse(RuntimeRetentionEphemeralScopeSchema, current);
  if (!parsedScope.success) throw new RuntimeRetentionError('RETENTION_EPHEMERAL_INVALID');
  if (
    typeof entry.toolCallId !== 'string' ||
    typeof entry.toolName !== 'string' ||
    entry.toolCallId.length === 0 ||
    entry.toolName.length === 0 ||
    !isRuntimeRetentionToolName(entry.toolName)
  ) {
    throw new RuntimeRetentionError('RETENTION_EPHEMERAL_INVALID');
  }
  if (!isRuntimeJsonValue(entry.input))
    throw new RuntimeRetentionError('RETENTION_EPHEMERAL_INVALID');
  let input: JSONValue;
  try {
    input = cloneRuntimeJsonValue(entry.input);
  } catch {
    throw new RuntimeRetentionError('RETENTION_EPHEMERAL_INVALID');
  }
  return {
    ...entry,
    input,
    scope: parsedScope.output,
  };
}

export function captureRuntimeEphemeralToolResult(
  current: RuntimeRetentionEphemeralScope,
  entry: Omit<RuntimeRetentionEphemeralToolResult, 'scope'>,
): RuntimeRetentionEphemeralToolResult {
  const parsedScope = v.safeParse(RuntimeRetentionEphemeralScopeSchema, current);
  if (!parsedScope.success) throw new RuntimeRetentionError('RETENTION_EPHEMERAL_INVALID');
  if (
    typeof entry.toolCallId !== 'string' ||
    typeof entry.toolName !== 'string' ||
    entry.toolCallId.length === 0 ||
    entry.toolName.length === 0 ||
    !isRuntimeRetentionToolName(entry.toolName)
  ) {
    throw new RuntimeRetentionError('RETENTION_EPHEMERAL_INVALID');
  }
  if (!isRuntimeJsonValue(entry.output))
    throw new RuntimeRetentionError('RETENTION_EPHEMERAL_INVALID');
  const parsedFreshUntil = v.safeParse(IsoTimestampSchema, entry.localFreshUntil);
  const parsedExpiresAt = v.safeParse(IsoTimestampSchema, entry.localExpiresAt);
  if (!parsedFreshUntil.success || !parsedExpiresAt.success) {
    throw new RuntimeRetentionError('RETENTION_EPHEMERAL_INVALID');
  }
  if (Date.parse(parsedFreshUntil.output) > Date.parse(parsedExpiresAt.output)) {
    throw new RuntimeRetentionError('RETENTION_EPHEMERAL_INVALID');
  }
  let output: JSONValue;
  try {
    output = cloneRuntimeJsonValue(entry.output);
  } catch {
    throw new RuntimeRetentionError('RETENTION_EPHEMERAL_INVALID');
  }
  return {
    ...entry,
    output,
    localFreshUntil: parsedFreshUntil.output,
    localExpiresAt: parsedExpiresAt.output,
    scope: parsedScope.output,
  };
}

export function runtimeEphemeralIsUsable(
  entry: RuntimeRetentionEphemeralToolCall | RuntimeRetentionEphemeralToolResult,
  currentScope: RuntimeRetentionScopeIdentity,
  now: string,
): boolean {
  const parsedEntryScope = v.safeParse(RuntimeRetentionEphemeralScopeSchema, entry.scope);
  const parsedCurrentScope = v.safeParse(RuntimeRetentionScopeIdentitySchema, currentScope);
  if (!parsedEntryScope.success || !parsedCurrentScope.success) return false;
  if (
    parsedEntryScope.output.ownerScopeRef === parsedCurrentScope.output.ownerScopeRef &&
    parsedEntryScope.output.threadId === parsedCurrentScope.output.threadId &&
    parsedEntryScope.output.turnId === parsedCurrentScope.output.turnId
  ) {
    if (!isRuntimeRetentionWindowOpen(parsedEntryScope.output.retention, now)) return false;
    if ('output' in entry) {
      const parsedNow = v.safeParse(IsoTimestampSchema, now);
      const parsedFreshUntil = v.safeParse(IsoTimestampSchema, entry.localFreshUntil);
      const parsedExpiresAt = v.safeParse(IsoTimestampSchema, entry.localExpiresAt);
      if (!parsedNow.success || !parsedFreshUntil.success || !parsedExpiresAt.success) return false;
      const nowMs = Date.parse(parsedNow.output);
      return (
        nowMs < Date.parse(parsedFreshUntil.output) && nowMs < Date.parse(parsedExpiresAt.output)
      );
    }
    return true;
  }
  return false;
}
