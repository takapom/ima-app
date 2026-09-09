import type { AgentContext, Connection } from 'agents';
import { MessageType } from 'agents/chat';
import type { SaveMessagesOptions, SaveMessagesResult } from '@cloudflare/ai-chat';
import type { UIMessage } from 'ai';
import {
  type RetentionRuntimeContext,
  type RetentionRuntimeSurface,
  type RetentionPolicy,
} from './retention/retention-runtime';
import { FixtureClock } from './retention/retention-fixture';
import { handleRetentionRequest } from './retention/retention-runtime-operations';
import { sanitizeRuntimeGateMessage } from './runtime-gate-sanitize';

export { sanitizeRuntimeGateMessage } from './runtime-gate-sanitize';

export type RuntimeGateRetentionHost = {
  readonly messages: UIMessage[];
  persistMessages(messages: UIMessage[], excludeBroadcastIds?: string[]): Promise<void>;
  saveMessages(
    messages:
      UIMessage[] | ((currentMessages: readonly UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
    options?: SaveMessagesOptions,
  ): Promise<SaveMessagesResult>;
  configureRuntimeScenario?(scenario: 'structured-error' | 'cancel'): void;
  configureRetentionFailure?(): void;
  clearRetentionFailure?(): void;
  fetch(request: Request): Promise<Response>;
  getConnections(tag?: string): Iterable<Connection>;
  onMessage(connection: Connection, message: string): void | Promise<void>;
};

/** Public AIChatAgent seam used by the retention route and tests. */
export class RuntimeGateRetentionSurface implements RetentionRuntimeSurface {
  private readonly clockValue = new FixtureClock('2026-09-08T04:20:00+09:00');
  private readonly token = crypto.randomUUID();
  private context: RetentionRuntimeContext | undefined;
  private policy: RetentionPolicy = 'allow';
  private readonly activeInputIds = new Set<string>();

  constructor(
    private readonly host: RuntimeGateRetentionHost,
    private readonly agentContext: AgentContext,
  ) {}

  get messages(): UIMessage[] {
    return this.host.messages;
  }

  get storage(): DurableObjectStorage {
    return this.agentContext.storage;
  }

  get clock(): FixtureClock {
    return this.clockValue;
  }

  setRetentionContext(context: RetentionRuntimeContext): void {
    this.context = context;
  }

  setRetentionScenario(policy: RetentionPolicy): void {
    this.policy = policy;
    if (policy === 'failure') {
      this.host.configureRuntimeScenario?.('structured-error');
      this.host.configureRetentionFailure?.();
      return;
    }
    this.host.clearRetentionFailure?.();
    if (policy === 'disconnect') this.host.configureRuntimeScenario?.('cancel');
  }

  instanceToken(): string {
    return this.token;
  }

  persistMessages(messages: UIMessage[]): Promise<void> {
    return this.host.persistMessages(messages);
  }

  async saveMessages(
    messages:
      UIMessage[] | ((currentMessages: readonly UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
    options?: SaveMessagesOptions,
  ): Promise<SaveMessagesResult> {
    const ids = Array.isArray(messages) ? messages.map((message) => message.id) : [];
    ids.forEach((id) => this.activeInputIds.add(id));
    try {
      return await this.host.saveMessages(messages, options);
    } finally {
      ids.forEach((id) => this.activeInputIds.delete(id));
    }
  }

  async clearChat(): Promise<void> {
    const clearUri = 'https://runtime-gate.local/runtime-gate-retention-clear';
    const response = await this.host.fetch(
      new Request(clearUri, {
        headers: { Upgrade: 'websocket' },
      }),
    );
    if (response.status !== 101) {
      throw new Error('RETENTION_CLEAR_CONNECTION_MISSING');
    }
    const connection = [...this.host.getConnections()].find(
      (candidate) => candidate.uri === clearUri,
    );
    if (connection === undefined) {
      throw new Error('RETENTION_CLEAR_CONNECTION_MISSING');
    }
    try {
      await this.host.onMessage(
        connection,
        JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }),
      );
    } finally {
      connection.close();
    }
  }

  sanitize(message: UIMessage): UIMessage {
    return sanitizeRuntimeGateMessage(message, this.context, this.clock, this.activeInputIds);
  }

  handle(request: Request): Promise<Response | undefined> {
    return handleRetentionRequest(request, this);
  }

  get activePolicy(): RetentionPolicy {
    return this.policy;
  }
}
