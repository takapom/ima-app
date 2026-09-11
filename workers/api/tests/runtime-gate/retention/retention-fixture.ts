import * as v from 'valibot';
import type { UIMessage } from 'ai';
import {
  IsoTimestampSchema,
  OpaqueIdSchema,
  RetentionMetadataSchema,
  type RetentionMetadata,
} from '@ima/core';
import {
  RetentionMessageMetadataSchema,
  type RetentionClock,
  type RetentionMessage,
  isRetentionExpired,
  parseRetentionMessage,
} from '../../support/retention-policy';
import {
  auditRetentionSurface,
  observeRetentionMessage,
  type RetentionAuditReport,
  type RetentionAuditSurface,
  type RetentionMessageObservation,
  type RetentionSqlReader,
  type RetentionStorageReader,
} from '../../support/retention-audit';

/** Clock used by the test harness; production code supplies its own ClockPort. */
export class FixtureClock implements RetentionClock {
  private current: string;

  constructor(initial: string) {
    this.current = v.parse(IsoTimestampSchema, initial);
  }

  now(): string {
    return this.current;
  }

  set(value: string): void {
    this.current = v.parse(IsoTimestampSchema, value);
  }
}

export type RetentionMessageInput = {
  id: string;
  role: RetentionMessage['role'];
  text: string;
  ownerScopeRef: string;
  threadId: string;
  turnId: string;
  retention: RetentionMetadata;
};

/** Build a server-owned message with injected identity and policy metadata. */
export function makeRetentionMessage(input: RetentionMessageInput): RetentionMessage {
  const metadata = v.parse(RetentionMessageMetadataSchema, {
    retention: v.parse(RetentionMetadataSchema, input.retention),
    ownerScopeRef: v.parse(OpaqueIdSchema, input.ownerScopeRef),
    threadId: v.parse(OpaqueIdSchema, input.threadId),
    turnId: v.parse(OpaqueIdSchema, input.turnId),
  });
  const parts: RetentionMessage['parts'] = [{ type: 'text', text: input.text }];
  return {
    id: v.parse(OpaqueIdSchema, input.id),
    role: input.role,
    parts,
    metadata,
  };
}

/** Adapter around an actual AIChatAgent; no in-memory persistence substitute is provided. */
export type RetentionPublicPersistence = {
  readMessages(): readonly UIMessage[];
  persistMessages(messages: UIMessage[]): Promise<void>;
};

export type RetentionPublicRuntimeSurface = RetentionPublicPersistence & {
  storage?: RetentionStorageReader;
  sql?: RetentionSqlReader;
};

export function auditCurrentRetentionSurface(
  surface: RetentionPublicRuntimeSurface,
  markers: readonly string[],
): Promise<RetentionAuditReport> {
  const auditSurface: RetentionAuditSurface = {
    messages: surface.readMessages(),
    ...(surface.storage === undefined ? {} : { storage: surface.storage }),
    ...(surface.sql === undefined ? {} : { sql: surface.sql }),
  };
  return auditRetentionSurface(auditSurface, markers);
}

export type RetentionExpiryClock = RetentionClock & {
  set(value: string): void;
};

export type RetentionRewriteEntry = {
  id: string;
  turnId: string;
  sameId: boolean;
  before: RetentionMessageObservation;
  after: RetentionMessageObservation;
};

export type RetentionRewriteReport = {
  now: string;
  persistedBatchSize: number;
  expired: readonly RetentionRewriteEntry[];
  active: readonly RetentionRewriteEntry[];
};

/**
 * Re-save the agent's complete current transcript through public persistMessages.
 * Scheduling and the AIChatAgent sanitizer remain outside this helper.
 */
export async function rewriteExpiredMessages(
  surface: RetentionPublicPersistence,
  clock: RetentionExpiryClock,
  at: string,
  markers: readonly string[],
): Promise<RetentionRewriteReport> {
  clock.set(at);
  const before = [...surface.readMessages()];
  await surface.persistMessages(before);
  const after = surface.readMessages();
  const afterById = new Map(after.map((message) => [message.id, message]));
  const entries = before.map((beforeMessage) => {
    const parsed = parseRetentionMessage(beforeMessage);
    if (parsed === undefined) throw new Error('RETENTION_METADATA_REQUIRED');
    const afterMessage = afterById.get(parsed.id);
    if (afterMessage === undefined) {
      throw new Error('RETENTION_REWRITE_MISSING_ID');
    }
    return {
      id: parsed.id,
      turnId: parsed.metadata.turnId,
      sameId: afterMessage.id === parsed.id,
      before: observeRetentionMessage(beforeMessage, markers),
      after: observeRetentionMessage(afterMessage, markers),
      expired: isRetentionExpired(parsed.metadata, clock.now()),
    };
  });
  return {
    now: clock.now(),
    persistedBatchSize: before.length,
    expired: entries
      .filter((entry) => entry.expired)
      .map(({ expired: _expired, ...entry }) => entry),
    active: entries
      .filter((entry) => !entry.expired)
      .map(({ expired: _expired, ...entry }) => entry),
  };
}
