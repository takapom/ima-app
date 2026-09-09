import type {
  PrepareStepContext,
  SaveMessagesOptions,
  SaveMessagesResult,
  Session,
  StepConfig,
  ThinkModel,
  ToolCallContext,
  ToolCallDecision,
  TurnConfig,
  TurnContext,
} from '@cloudflare/think';
import { Think } from '@cloudflare/think';
import type { ToolSet } from 'ai';
import {
  createRuntimeThinkConnection,
  RuntimeThinkConnectionError,
  type RuntimeThinkConnection,
  type RuntimeThinkConnectionOptions,
  type RuntimeThinkMessageInput,
} from '../runtime/runtime-think-connection';

/** Think-backed host shared by the production ThreadDO and its injected Worker fixtures. */
export class RuntimeThinkHost<Env extends Cloudflare.Env = Cloudflare.Env> extends Think<Env> {
  protected runtimeConnection: RuntimeThinkConnection<unknown> | null | undefined;
  private thinkSessionReady = false;

  /**
   * The concrete composition is supplied by the Worker registry. Keeping this protected avoids
   * a mutable process-wide registry and lets a fixture inject only model/Port dependencies.
   */
  protected createRuntimeThinkConnectionOptions():
    RuntimeThinkConnectionOptions<unknown> | undefined {
    return undefined;
  }

  protected ensureRuntimeThinkConnection(): RuntimeThinkConnection<unknown> | undefined {
    if (this.runtimeConnection !== undefined) return this.runtimeConnection ?? undefined;
    const injected = this.createRuntimeThinkConnectionOptions();
    if (injected === undefined) {
      this.runtimeConnection = null;
      return undefined;
    }
    const nativePersist = async (
      messages: RuntimeThinkMessageInput,
      options?: SaveMessagesOptions,
    ): Promise<SaveMessagesResult> => {
      // Native ThreadDO RPCs bypass Agent.fetch, so the first save must also establish Think's
      // Session before delegating to the SDK persistence path.
      await this.lifecycle.start();
      return super.saveMessages(messages, options);
    };
    this.runtimeConnection = createRuntimeThinkConnection({
      clock: injected.clock,
      configureSession: injected.configureSession,
      buildTurn: async (request) => ({
        ...(await injected.buildTurn(request)),
        // The connection sanitizes before this native Think persistence path.
        persistMessages: nativePersist,
      }),
    });
    return this.runtimeConnection;
  }

  protected requireRuntimeThinkConnection(): RuntimeThinkConnection<unknown> {
    const runtime = this.ensureRuntimeThinkConnection();
    if (runtime === undefined) {
      throw new RuntimeThinkConnectionError('RUNTIME_UNCONFIGURED');
    }
    return runtime;
  }

  protected async clearRuntimeMessages(): Promise<void> {
    // Native RPC methods do not run the Agent fetch startup path. Start Think through its
    // idempotent public lifecycle entry before clearing, so a cold DO cannot leave a durable
    // transcript behind. Calling onStart directly would bypass the SDK's startup guard.
    if (!this.thinkSessionReady) await this.lifecycle.start();
    await super.clearMessages();
  }

  override configureSession(session: Session): Session | Promise<Session> {
    this.thinkSessionReady = true;
    return this.ensureRuntimeThinkConnection()?.configureSession(session) ?? session;
  }

  override getModel(): ThinkModel {
    return this.requireRuntimeThinkConnection().getModel();
  }

  override getTools(): ToolSet {
    return this.requireRuntimeThinkConnection().getTools();
  }

  override beforeTurn(context: TurnContext): TurnConfig | void | Promise<TurnConfig | void> {
    return this.requireRuntimeThinkConnection().beforeTurn(context);
  }

  override beforeStep(context: PrepareStepContext): StepConfig | void | Promise<StepConfig | void> {
    return this.requireRuntimeThinkConnection().beforeStep(context);
  }

  override beforeToolCall(
    context: ToolCallContext,
  ): ToolCallDecision | void | Promise<ToolCallDecision | void> {
    return this.requireRuntimeThinkConnection().beforeToolCall(context);
  }
}
