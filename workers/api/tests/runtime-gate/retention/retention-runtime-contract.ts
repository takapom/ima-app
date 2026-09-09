import type { SaveMessagesOptions, SaveMessagesResult } from '@cloudflare/ai-chat';
import type { RetentionMetadata } from '@ima/core';
import type { UIMessage } from 'ai';
import type {
  RetentionAuditReport,
  RetentionSqlReader,
  RetentionStorageReader,
  RetentionWriteAuditInstallReport,
  RetentionWriteAuditReport,
} from './retention-audit';
import type { RetentionExpiryClock } from './retention-fixture';

export type RetentionPolicy = 'allow' | 'deny' | 'unknown' | 'failure' | 'disconnect';

export type RetentionOperation =
  | 'run'
  | 'prepare'
  | 'persistence'
  | 'expire'
  | 'save'
  | 'saved'
  | 'saved-delete'
  | 'clear'
  | 'read'
  | 'replay'
  | 'recover'
  | 'display'
  | 'remodel'
  | 'sweep'
  | 'delete'
  | 'report';

export type RetentionRuntimeStorage = RetentionStorageReader & {
  sql: RetentionSqlReader;
};

export type RetentionRuntimeContext = {
  ownerScopeRef: string;
  threadId: string;
  turnId: string;
  now: string;
  retention: RetentionMetadata;
  policy: RetentionPolicy;
};

/** The callbacks are direct adapters over one real AIChatAgent instance. */
export type RetentionRuntimeSurface = {
  messages: UIMessage[];
  persistMessages(messages: UIMessage[]): Promise<void>;
  saveMessages(
    messages:
      UIMessage[] | ((currentMessages: readonly UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
    options?: SaveMessagesOptions,
  ): Promise<SaveMessagesResult>;
  storage: RetentionRuntimeStorage;
  clock: RetentionExpiryClock;
  setRetentionContext(context: RetentionRuntimeContext): void;
  setRetentionScenario(policy: RetentionPolicy): void;
  instanceToken(): string;
  clearChat(): Promise<void>;
};

export type RetentionRuntimeReport = {
  operation: RetentionOperation;
  result: { status: SaveMessagesResult['status']; error: string | null } | null;
  responseId: string | null;
  turnId: string | null;
  persistenceBefore: RetentionAuditReport;
  persistenceAfter: RetentionAuditReport;
  writeAudit: RetentionWriteAuditReport;
  writeAuditInstall: RetentionWriteAuditInstallReport;
  savedCount: number;
  instanceToken: string;
  rawCanaryVisible: false;
};
