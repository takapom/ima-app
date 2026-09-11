import type { SaveMessagesOptions, SaveMessagesResult } from '@cloudflare/ai-chat';
import type { Think } from '@cloudflare/think';
import type { UIMessage } from 'ai';
import type { RetentionMetadata } from '@ima/core';
import {
  deleteRetentionSidecars,
  getRetentionSidecar,
  historyWithRetentionSidecars,
  putRetentionSidecar,
} from './think-retention-sidecar';
import {
  auditRetentionSurface,
  observeRetentionMessage,
  type RetentionAuditReport,
  type RetentionStorageReader,
} from '../../support/retention-audit';
import {
  FixtureClock,
  type RetentionExpiryClock,
  type RetentionRewriteEntry,
  type RetentionRewriteReport,
} from '../../runtime-gate/retention/retention-fixture';
import {
  isRetentionExpired,
  parseRetentionMessage,
  sanitizeMessageForPersistence,
  type RetentionMessageMetadata,
} from '../../support/retention-policy';
import type {
  RetentionPolicy,
  RetentionRuntimeContext,
  RetentionRuntimeSurface,
} from '../../runtime-gate/retention/retention-runtime';
import { retentionFor } from '../../runtime-gate/retention/retention-runtime';

export const THINK_RETENTION_MARKERS = [
  'M04_PROVIDER_QUOTE_CANARY',
  'M04_GENERATED_CANARY',
] as const;

export type ThinkRetentionScenarioSetter = (policy: RetentionPolicy) => void;

export type ThinkRetentionInventoryState = 'observed' | 'not-initialized' | 'read-error';

export type ThinkRetentionSurfaceInventory = {
  sqlTables: readonly string[];
  stream: {
    state: ThinkRetentionInventoryState;
    reason: string;
    tables: readonly string[];
  };
  workspace: {
    state: ThinkRetentionInventoryState;
    reason: string;
    tables: readonly string[];
  };
  recovery: {
    state: ThinkRetentionInventoryState;
    reason: string;
    tables: readonly string[];
  };
};

export type ThinkRetentionRewriteReport = RetentionRewriteReport & {
  publicPerMessageExpirySupported: true;
  publicBulkPersistSupported: false;
  publicPayloadScrubSupported: true;
  privateRewriteUsed: false;
  publicRewriteMethod: 'Session.updateMessage';
  updatedRows: number;
};

export type ThinkRetentionSurface = RetentionRuntimeSurface & {
  readonly think: Think;
  audit(): Promise<RetentionAuditReport>;
  history(): Promise<readonly unknown[]>;
  compactions(): Promise<readonly unknown[]>;
  rewriteExpiredRetentionMessages(at: string): Promise<ThinkRetentionRewriteReport>;
  compact(summary: string): Promise<{
    id: string;
    summary: string;
    fromMessageId: string;
    toMessageId: string;
  }>;
  inventory(audit: RetentionAuditReport): ThinkRetentionSurfaceInventory;
};

function hasMarker(value: string): boolean {
  return THINK_RETENTION_MARKERS.some((marker) => value.includes(marker));
}

function tableNamesFromAudit(audit: RetentionAuditReport): readonly string[] {
  if (!audit.sql.observed) return [];
  return audit.sql.tables.map((table) => table.tableName);
}

function classifyTables(
  names: readonly string[],
  predicate: (name: string) => boolean,
): readonly string[] {
  return names.filter((name) => predicate(name.toLowerCase()));
}

function surfaceState(
  names: readonly string[],
  audit: RetentionAuditReport,
): ThinkRetentionInventoryState {
  if (!audit.sql.observed || audit.sql.readErrors > 0) return 'read-error';
  return names.length > 0 ? 'observed' : 'not-initialized';
}

function retentionEntry(before: UIMessage, after: UIMessage): RetentionRewriteEntry {
  const parsed = parseRetentionMessage(before);
  if (parsed === undefined) throw new Error('RETENTION_METADATA_REQUIRED');
  return {
    id: parsed.id,
    turnId: parsed.metadata.turnId,
    sameId: after.id === parsed.id,
    before: observeRetentionMessage(before, THINK_RETENTION_MARKERS),
    after: observeRetentionMessage(after, THINK_RETENTION_MARKERS),
  };
}

function mapById(messages: readonly UIMessage[]): ReadonlyMap<string, UIMessage> {
  return new Map(messages.map((message) => [message.id, message]));
}

function serverMetadata(metadata: RetentionMessageMetadata): RetentionMetadata {
  return { ...metadata.retention, attribution: null };
}

/**
 * Adapter over one real Think Durable Object. It only calls public Session and
 * Think methods; SQL/KV are supplied for read-only audit and fixture-owned
 * response/reference records.
 */
export class ThinkRetentionRuntimeSurface implements ThinkRetentionSurface {
  private readonly clockValue: RetentionExpiryClock = new FixtureClock('2026-09-08T04:20:00+09:00');
  private readonly token = crypto.randomUUID();
  private context: RetentionRuntimeContext | undefined;
  private policy: RetentionPolicy = 'allow';

  constructor(
    readonly think: Think,
    private readonly storageValue: DurableObjectState['storage'],
    private readonly setScenario: ThinkRetentionScenarioSetter,
  ) {}

  get messages(): UIMessage[] {
    return this.think.messages;
  }

  get storage(): RetentionStorageReader & { sql: DurableObjectState['storage']['sql'] } {
    return this.storageValue;
  }

  get clock(): RetentionExpiryClock {
    return this.clockValue;
  }

  setRetentionContext(context: RetentionRuntimeContext): void {
    this.context = context;
  }

  setRetentionScenario(policy: RetentionPolicy): void {
    this.policy = policy;
    this.setScenario(policy);
  }

  activePolicy(): RetentionPolicy {
    return this.policy;
  }

  instanceToken(): string {
    return this.token;
  }

  audit(): Promise<RetentionAuditReport> {
    return this.auditWithHistory();
  }

  private async auditWithHistory(): Promise<RetentionAuditReport> {
    const history = await this.think.session.getHistory();
    const messages = await historyWithRetentionSidecars(this.storageValue, history);
    return auditRetentionSurface(
      {
        messages,
        storage: this.storage,
        sql: this.storage.sql,
      },
      THINK_RETENTION_MARKERS,
    );
  }

  private sanitize(message: UIMessage): UIMessage {
    const parsed = parseRetentionMessage(message);
    if (parsed === undefined) throw new Error('RETENTION_METADATA_REQUIRED');
    const context = this.context;
    if (
      context !== undefined &&
      (parsed.metadata.ownerScopeRef !== context.ownerScopeRef ||
        parsed.metadata.threadId !== context.threadId)
    ) {
      throw new Error('RETENTION_OWNER_OR_THREAD_MISMATCH');
    }
    const sanitized = sanitizeMessageForPersistence(message, {
      clock: this.clock,
      ownerScopeRef: parsed.metadata.ownerScopeRef,
      threadId: parsed.metadata.threadId,
    });
    return {
      id: sanitized.id,
      role: sanitized.role,
      parts: sanitized.parts,
      metadata: {
        retention: serverMetadata(sanitized.metadata),
        ownerScopeRef: sanitized.metadata.ownerScopeRef,
        threadId: sanitized.metadata.threadId,
        turnId: sanitized.metadata.turnId,
      },
    };
  }

  private sanitizeBatch(messages: readonly UIMessage[]): UIMessage[] {
    return messages.map((message) => {
      const parsed = parseRetentionMessage(message);
      if (parsed === undefined) return this.unknownMessage();
      if (
        [
          parsed.id,
          parsed.metadata.ownerScopeRef,
          parsed.metadata.threadId,
          parsed.metadata.turnId,
        ].some(hasMarker)
      ) {
        throw new Error('RETENTION_IDENTIFIER_FORBIDDEN');
      }
      return this.sanitize(message);
    });
  }

  private unknownMessage(): UIMessage {
    const ownerScopeRef = 'owner-think-native';
    const threadId = 'thread-think-native';
    const turnId = `turn-think-native-${this.token}`;
    return {
      id: `think-retention-withheld-${crypto.randomUUID()}`,
      role: 'user',
      parts: [{ type: 'text', text: '[withheld]' }],
      metadata: {
        retention: retentionFor('unknown', this.clock.now(), null),
        ownerScopeRef,
        threadId,
        turnId,
      },
    };
  }

  async saveMessages(
    messages:
      UIMessage[] | ((currentMessages: readonly UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
    options?: SaveMessagesOptions,
  ): Promise<SaveMessagesResult> {
    if (this.policy === 'failure') throw new Error('M04_RETENTION_PROVIDER_FAILURE');
    if (this.policy === 'disconnect') throw new Error('M04_RETENTION_DISCONNECTED');
    const next =
      typeof messages === 'function' ? await messages([...this.think.messages]) : messages;
    const sanitized = this.sanitizeBatch(next);
    for (const message of sanitized) {
      const parsed = parseRetentionMessage(message);
      if (parsed !== undefined) {
        await putRetentionSidecar(this.storageValue, parsed.id, parsed.metadata);
      }
    }
    return this.think.saveMessages(sanitized, options);
  }

  /** Public Session upsert, used only for the expiry rewrite proof. */
  async persistMessages(messages: UIMessage[]): Promise<void> {
    for (const message of messages) {
      const parsed = parseRetentionMessage(message);
      const sidecar =
        parsed === undefined ? await getRetentionSidecar(this.storageValue, message.id) : undefined;
      const source =
        parsed !== undefined || sidecar === undefined
          ? message
          : ({ ...message, metadata: sidecar } satisfies UIMessage);
      const sanitized = this.sanitize(source);
      const existing = await this.think.session.getMessage(message.id);
      if (existing === null) {
        await this.think.session.appendMessage(sanitized);
      } else {
        await this.think.session.updateMessage(sanitized);
      }
      const updated = parseRetentionMessage(sanitized);
      if (updated !== undefined) {
        await putRetentionSidecar(this.storageValue, updated.id, updated.metadata);
      }
    }
  }

  async clearChat(): Promise<void> {
    await this.think.clearMessages();
    await deleteRetentionSidecars(this.storageValue);
  }

  async history(): Promise<readonly unknown[]> {
    return this.think.session.getHistory();
  }

  async compactions(): Promise<readonly unknown[]> {
    return this.think.session.getCompactions();
  }

  async rewriteExpiredRetentionMessages(at: string): Promise<ThinkRetentionRewriteReport> {
    this.clock.set(at);
    const before = await historyWithRetentionSidecars(
      this.storageValue,
      await this.think.session.getHistory(),
    );
    const retained = before.filter((message) => parseRetentionMessage(message) !== undefined);
    for (const message of retained) {
      const rawMessage = {
        id: message.id,
        role: message.role,
        parts: message.parts,
      } satisfies UIMessage;
      await this.persistMessages([rawMessage]);
    }
    const after = await historyWithRetentionSidecars(
      this.storageValue,
      await this.think.session.getHistory(),
    );
    const afterById = mapById(after);
    const entries = retained.map((message) => {
      const afterMessage = afterById.get(message.id);
      if (afterMessage === undefined) throw new Error('RETENTION_REWRITE_MISSING_ID');
      return {
        ...retentionEntry(message, afterMessage),
        expired: isRetentionExpired(
          parseRetentionMessage(message)?.metadata ??
            (() => {
              throw new Error('RETENTION_METADATA_REQUIRED');
            })(),
          this.clock.now(),
        ),
      };
    });
    return {
      now: this.clock.now(),
      persistedBatchSize: retained.length,
      expired: entries
        .filter((entry) => entry.expired)
        .map(({ expired: _expired, ...entry }) => entry),
      active: entries
        .filter((entry) => !entry.expired)
        .map(({ expired: _expired, ...entry }) => entry),
      publicPerMessageExpirySupported: true,
      publicBulkPersistSupported: false,
      publicPayloadScrubSupported: true,
      privateRewriteUsed: false,
      publicRewriteMethod: 'Session.updateMessage',
      updatedRows: retained.length,
    };
  }

  sanitizeCompactionSummary(summary: string): string {
    // A summary can aggregate multiple turns. The current turn policy cannot
    // prove that every source turn permits body retention. Canary strings are
    // audit observations only, so raw summaries remain reference-only.
    void summary;
    return '[withheld]';
  }

  compactionResult(
    messages: readonly { id: string }[],
    summary: string,
  ): {
    summary: string;
    fromMessageId: string;
    toMessageId: string;
  } | null {
    const first = messages[0];
    const last = messages.at(-1);
    if (first === undefined || last === undefined) return null;
    return {
      summary: this.sanitizeCompactionSummary(summary),
      fromMessageId: first.id,
      toMessageId: last.id,
    };
  }

  async compact(
    summary: string,
  ): Promise<{ id: string; summary: string; fromMessageId: string; toMessageId: string }> {
    this.think.session.onCompaction((messages) =>
      Promise.resolve(this.compactionResult(messages, summary)),
    );
    const result = await this.think.session.compact();
    if (result === null) throw new Error('COMPACTION_NO_RESULT');
    const stored = (await this.think.session.getCompactions()).at(-1);
    if (stored === undefined) throw new Error('COMPACTION_NOT_STORED');
    return stored;
  }

  inventory(audit: RetentionAuditReport): ThinkRetentionSurfaceInventory {
    const names = tableNamesFromAudit(audit);
    const stream = classifyTables(names, (name) => name.includes('stream'));
    const workspace = classifyTables(
      names,
      (name) => name.includes('workspace') || name.includes('attachment'),
    );
    const recovery = classifyTables(
      names,
      (name) => name.includes('recovery') || name.includes('fiber') || name.includes('stash'),
    );
    return {
      sqlTables: names,
      stream: {
        state: surfaceState(stream, audit),
        reason:
          stream.length > 0
            ? 'Think/core が所有するstream表を監査した'
            : 'stream bufferはcore担当で、このfixtureは公開Session保存だけを実行した',
        tables: stream,
      },
      workspace: {
        state: surfaceState(workspace, audit),
        reason:
          workspace.length > 0
            ? 'workspace表を公開SQLで監査した'
            : 'workspaceBash=falseでworkspace toolを呼び出していないため未初期化',
        tables: workspace,
      },
      recovery: {
        state: surfaceState(recovery, audit),
        reason:
          recovery.length > 0
            ? 'recovery/fiber表は公開SQLで監査したがalarm遅延経路は起動していない'
            : 'このbounded fixtureではalarm遅延を含むrecovery経路を起動していない',
        tables: recovery,
      },
    };
  }
}
