import type {
  PrepareStepContext,
  SaveMessagesOptions,
  SaveMessagesResult,
  Session,
  StepConfig,
  ToolCallContext,
  TurnConfig,
  TurnContext,
} from '@cloudflare/think';
import type { ThreadTurnRequest } from '@ima/contracts';
import type { ModelMessage, UIMessage } from 'ai';
import {
  attachRuntimeRetentionContext,
  sanitizeRuntimeMessagesForPersistence,
  type RuntimeRetentionContext,
  type RuntimeRetentionMessage,
} from '../runtime-retention';
import {
  wrapRuntimeModelGuard,
  type RuntimeModelGuardAcceptance,
  type RuntimeModelGuardModel,
  type RuntimeModelGuardCallOptions,
  type RuntimeModelGuardErrorCode,
  type RuntimeModelGuardOptions,
} from './runtime-model-guard';
import type { RuntimeBeforeToolCallDelegate, RuntimeTurnHandle } from './runtime-turn-factory';
import type { RuntimeBudget } from '../runtime-budget';

export type RuntimeThinkMessageInput =
  UIMessage[] | ((currentMessages: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>);

export type RuntimeThinkTurnRequest = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly messages: readonly UIMessage[];
  /** Authenticated device identity; it is never encoded as an SDK message. */
  readonly deviceId?: string;
  /** Validated Worker input for the turn builder; this is never sent as an SDK message. */
  readonly runtimeInput?: ThreadTurnRequest;
  readonly signal?: AbortSignal;
  readonly isStale?: () => boolean;
};

export type RuntimeThinkTurnBuildRequest = RuntimeThinkTurnRequest & {
  /** Wall clock sampled immediately before the turn is built. */
  readonly serverNow: string;
};

export type RuntimeThinkRetention = {
  /** A function permits a provider to rotate server-owned retention metadata per save. */
  readonly context: RuntimeRetentionContext | (() => RuntimeRetentionContext);
  /** The structural AI SDK stream transform used for every native turn. */
  readonly transform: RuntimeThinkRetentionTransform;
};

export type RuntimeThinkRetentionTransform = NonNullable<TurnConfig['experimental_transform']>;

export type RuntimeThinkProjectedStep = {
  readonly messages: ModelMessage[];
  readonly experimental_context?: unknown;
};

export type RuntimeThinkStepProjection = (
  context: PrepareStepContext,
  serverNow: string,
) => RuntimeThinkProjectedStep | Promise<RuntimeThinkProjectedStep>;

export type RuntimeThinkComposition<Response = unknown> = {
  /** The unwrapped, explicitly injected AI SDK V3 model. */
  readonly model: RuntimeModelGuardModel;
  /** Provider-specific options injected into every AI SDK model call for this turn. */
  readonly providerOptions?: TurnConfig['providerOptions'];
  /** Runtime factory owns tools, budget, cancellation, and Core Port adapters. */
  readonly turn: RuntimeTurnHandle;
  /** The current server-owned retention policy used at every persistence boundary. */
  readonly retention: RuntimeThinkRetention;
  /** M08 projection is mandatory; raw SDK history is never projected by this adapter. */
  readonly projectStep: RuntimeThinkStepProjection;
  /** The host persistence method is injected per composition and always receives sanitized data. */
  readonly persistMessages: RuntimeThinkPersistMessages;
  /** Returns a cloned Core ephemeral response before the turn is disposed. */
  readonly getCommittedResponse: () => Response | undefined | Promise<Response | undefined>;
  /** Clears Core ephemeral state and other per-turn maps. */
  readonly dispose: () => void;
  /** Guard must distinguish read/tool steps from the final-response reserve. */
  readonly isFinalResponse: (params: RuntimeModelGuardCallOptions) => boolean;
  /** Composition gate limits the final-response reserve to one model call. */
  readonly reserveModelStep?: RuntimeBudget['reserveModelStep'];
  /** Accepted final text is handed to Core before the turn is disposed. */
  readonly onAccepted: (acceptance: RuntimeModelGuardAcceptance) => void;
};

export type RuntimeThinkTurnBuilder<Response = unknown> = (
  request: RuntimeThinkTurnBuildRequest,
) => RuntimeThinkComposition<Response> | Promise<RuntimeThinkComposition<Response>>;

export type RuntimeThinkPersistMessages = (
  messages: RuntimeThinkMessageInput,
  options?: SaveMessagesOptions,
) => Promise<SaveMessagesResult>;
export type RuntimeThinkConnectionOptions<Response = unknown> = {
  /** Must be monotonic with respect to the retention policy's server timestamp source. */
  readonly clock: () => string;
  /** Builds one factory/model/Port composition; no request state is stored in this callback. */
  readonly buildTurn: RuntimeThinkTurnBuilder<Response>;
  /** Required common Session policy; this must install the retention/compaction hook. */
  readonly configureSession: (session: Session) => Session | Promise<Session>;
};

export type RuntimeThinkTurnResult<Response = unknown> = SaveMessagesResult & {
  readonly response: Response | null;
  /** Internal typed guard denial; Think's SaveMessagesResult only exposes a string. */
  readonly runtimeGuardFailureCode?: RuntimeModelGuardErrorCode;
};
export type RuntimeThinkConnectionErrorCode =
  | 'TURN_ALREADY_ACTIVE'
  | 'TURN_NOT_ACTIVE'
  | 'RUNTIME_UNCONFIGURED'
  | 'COMPOSITION_INVALID'
  | 'CANCELLED'
  | 'STALE_TURN';
const connectionErrors = new WeakSet<object>();

export class RuntimeThinkConnectionError extends Error {
  readonly code: RuntimeThinkConnectionErrorCode;

  constructor(code: RuntimeThinkConnectionErrorCode) {
    super(`runtime Think connection denied: ${code}`);
    this.name = 'RuntimeThinkConnectionError';
    this.code = code;
    connectionErrors.add(this);
  }
}

export const isRuntimeThinkConnectionError = (
  value: unknown,
): value is RuntimeThinkConnectionError =>
  typeof value === 'object' && value !== null && connectionErrors.has(value);

type StartingTurn = {
  readonly controller: AbortController;
};

type ActiveTurn<Response> = {
  readonly request: RuntimeThinkTurnBuildRequest;
  readonly composition: RuntimeThinkComposition<Response>;
  readonly model: RuntimeModelGuardModel;
  readonly controller: AbortController;
};

type RuntimeThinkCleanup = {
  readonly run: () => void;
  readonly error: () => unknown;
};

const retentionContext = (retention: RuntimeThinkRetention): RuntimeRetentionContext =>
  typeof retention.context === 'function' ? retention.context() : retention.context;

const requestAborted = (request: RuntimeThinkTurnRequest): boolean =>
  request.signal?.aborted === true;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isRetentionTransform = (value: unknown): value is RuntimeThinkRetentionTransform =>
  typeof value === 'function' ||
  (Array.isArray(value) && value.every((item) => typeof item === 'function'));

const isUsableComposition = <Response>(
  value: unknown,
): value is RuntimeThinkComposition<Response> => {
  if (!record(value)) return false;
  const turn = value.turn;
  const retention = value.retention;
  if (!record(turn) || !record(retention)) return false;
  const hooks = turn.hooks;
  const budget = turn.budget;
  return (
    typeof value.model === 'object' &&
    value.model !== null &&
    typeof value.projectStep === 'function' &&
    typeof value.persistMessages === 'function' &&
    typeof value.getCommittedResponse === 'function' &&
    typeof value.dispose === 'function' &&
    typeof value.isFinalResponse === 'function' &&
    typeof value.onAccepted === 'function' &&
    (typeof retention.context === 'function' || record(retention.context)) &&
    isRetentionTransform(retention.transform) &&
    record(hooks) &&
    typeof hooks.beforeTurn === 'function' &&
    typeof hooks.beforeStep === 'function' &&
    typeof hooks.beforeToolCall === 'function' &&
    record(budget) &&
    typeof turn.isDisposed === 'function' &&
    typeof turn.dispose === 'function'
  );
};

const sameTurnIdentity = (
  request: RuntimeThinkTurnRequest,
  context: Pick<RuntimeRetentionContext, 'ownerScopeRef' | 'threadId' | 'turnId'> & {
    readonly revision: number;
  },
): boolean =>
  request.ownerScopeRef === context.ownerScopeRef &&
  request.threadId === context.threadId &&
  request.turnId === context.turnId &&
  request.revision === context.revision;

const sameRetentionIdentity = (
  request: RuntimeThinkTurnRequest,
  context: Pick<RuntimeRetentionContext, 'ownerScopeRef' | 'threadId' | 'turnId'>,
): boolean =>
  request.ownerScopeRef === context.ownerScopeRef &&
  request.threadId === context.threadId &&
  request.turnId === context.turnId;

const linkAbortSignal = (
  source: AbortSignal | undefined,
  target: AbortController,
): (() => void) => {
  const onAbort = (): void => target.abort();
  if (source?.aborted === true) onAbort();
  else source?.addEventListener('abort', onAbort, { once: true });
  return () => source?.removeEventListener('abort', onAbort);
};

const thrownError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

const cleanupFor = <Response>(
  composition: RuntimeThinkComposition<Response>,
): RuntimeThinkCleanup => {
  let completed = false;
  let firstError: unknown;
  return {
    run: () => {
      if (completed) return;
      completed = true;
      try {
        composition.dispose();
      } catch (error) {
        firstError = error;
      }
      try {
        composition.turn.dispose();
      } catch (error) {
        firstError ??= error;
      }
    },
    error: () => firstError,
  };
};

const linkCleanupToAbort = (signal: AbortSignal, cleanup: RuntimeThinkCleanup): (() => void) => {
  const onAbort = (): void => cleanup.run();
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
};

/**
 * Adapts one injected RuntimeTurnFactory composition to Think's public lifecycle surface.
 * Think still owns the model loop; this class only installs the validated model, hooks, and
 * persistence boundary while the composition is active.
 */
export class RuntimeThinkConnection<Response = unknown> {
  private active: StartingTurn | ActiveTurn<Response> | undefined;

  constructor(private readonly options: RuntimeThinkConnectionOptions<Response>) {
    if (typeof options.clock !== 'function' || typeof options.buildTurn !== 'function') {
      throw new RuntimeThinkConnectionError('RUNTIME_UNCONFIGURED');
    }
    if (typeof options.configureSession !== 'function') {
      throw new RuntimeThinkConnectionError('RUNTIME_UNCONFIGURED');
    }
  }

  getModel(): RuntimeModelGuardModel {
    return this.requireActive().model;
  }

  getTools(): RuntimeTurnHandle['tools'] {
    return this.requireActive().composition.turn.tools;
  }

  async beforeTurn(context: TurnContext): Promise<TurnConfig> {
    const active = this.requireActive();
    this.assertTurnUsable(active);
    const base = await active.composition.turn.hooks.beforeTurn(context);
    this.assertTurnUsable(active);
    const providerOptions =
      active.composition.providerOptions === undefined
        ? base?.providerOptions
        : { ...(base?.providerOptions ?? {}), ...active.composition.providerOptions };
    return {
      ...(base ?? {}),
      ...(providerOptions === undefined ? {} : { providerOptions }),
      experimental_transform: active.composition.retention.transform,
    };
  }

  async beforeStep(context: PrepareStepContext): Promise<StepConfig | void> {
    const active = this.requireActive();
    this.assertTurnUsable(active);
    const base = await active.composition.turn.hooks.beforeStep(context);
    this.assertTurnUsable(active);
    const projected = await active.composition.projectStep(context, this.options.clock());
    this.assertTurnUsable(active);
    if (!Array.isArray(projected.messages)) {
      throw new RuntimeThinkConnectionError('COMPOSITION_INVALID');
    }
    const safeProjection = {
      ...(base ?? {}),
      messages: projected.messages,
      ...(projected.experimental_context === undefined
        ? {}
        : { experimental_context: projected.experimental_context }),
    };
    return safeProjection;
  }

  beforeToolCall(context: ToolCallContext): ReturnType<RuntimeBeforeToolCallDelegate> {
    return this.requireActive().composition.turn.hooks.beforeToolCall(context);
  }

  configureSession(session: Session): Session | Promise<Session> {
    return this.options.configureSession(session);
  }

  /** Public save boundary used by a Think subclass; raw SDK messages never reach persistence. */
  saveMessages(
    messages: RuntimeThinkMessageInput,
    options?: SaveMessagesOptions,
  ): Promise<SaveMessagesResult> {
    const active = this.requireActive();
    if (active.composition.turn.isDisposed() || options?.signal?.aborted === true) {
      throw new RuntimeThinkConnectionError('CANCELLED');
    }
    const persist = active.composition.persistMessages;
    const sanitize = (items: readonly UIMessage[]): RuntimeRetentionMessage[] => {
      const context = retentionContext(active.composition.retention);
      if (!sameRetentionIdentity(active.request, context)) {
        throw new RuntimeThinkConnectionError('COMPOSITION_INVALID');
      }
      const now = this.options.clock();
      const serverOwned = items.map((message) =>
        message.metadata === undefined ? attachRuntimeRetentionContext(message, context) : message,
      );
      return sanitizeRuntimeMessagesForPersistence(serverOwned, context, now);
    };
    if (typeof messages === 'function') {
      return persist(async (currentMessages) => sanitize(await messages(currentMessages)), options);
    }
    return persist(sanitize(messages), options);
  }

  async run(request: RuntimeThinkTurnRequest): Promise<RuntimeThinkTurnResult<Response>> {
    if (this.active !== undefined) {
      throw new RuntimeThinkConnectionError('TURN_ALREADY_ACTIVE');
    }
    if (requestAborted(request)) {
      throw new RuntimeThinkConnectionError('CANCELLED');
    }
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(request.signal, controller);
    const serverNow = this.options.clock();
    const buildRequest: RuntimeThinkTurnBuildRequest = {
      ...request,
      signal: controller.signal,
      serverNow,
    };
    this.active = { request: buildRequest, controller };
    let composition: RuntimeThinkComposition<Response> | undefined;
    let cleanup: RuntimeThinkCleanup | undefined;
    let unlinkCleanup: (() => void) | undefined;
    let result: RuntimeThinkTurnResult<Response> | undefined;
    let runtimeGuardFailureCode: RuntimeModelGuardErrorCode | undefined;
    let primaryError: unknown;
    let hasPrimaryError = false;
    let cleanupError: unknown;
    try {
      const built = await this.options.buildTurn(buildRequest);
      if (!isUsableComposition<Response>(built)) {
        throw new RuntimeThinkConnectionError('COMPOSITION_INVALID');
      }
      composition = built;
      const compositionCleanup = cleanupFor(composition);
      cleanup = compositionCleanup;
      unlinkCleanup = linkCleanupToAbort(controller.signal, compositionCleanup);
      if (buildRequest.signal?.aborted === true || requestAborted(request)) {
        throw new RuntimeThinkConnectionError('CANCELLED');
      }
      if (request.isStale?.() === true) {
        throw new RuntimeThinkConnectionError('STALE_TURN');
      }
      if (!sameTurnIdentity(request, composition.turn.context)) {
        throw new RuntimeThinkConnectionError('COMPOSITION_INVALID');
      }
      if (!sameRetentionIdentity(request, retentionContext(composition.retention))) {
        throw new RuntimeThinkConnectionError('COMPOSITION_INVALID');
      }
      const guardOptions: RuntimeModelGuardOptions = {
        budget: {
          reserveModelStep:
            composition.reserveModelStep ??
            composition.turn.budget.reserveModelStep.bind(composition.turn.budget),
          checkAdmission: composition.turn.budget.checkAdmission.bind(composition.turn.budget),
        },
        remainingTimeMs: (finalResponse) =>
          composition?.turn.budget.remainingModelTimeMs(finalResponse) ?? 0,
        isFinalResponse: composition.isFinalResponse,
        onAccepted: composition.onAccepted,
        onFailure: (error) => {
          runtimeGuardFailureCode = error.code;
        },
      };
      const model = wrapRuntimeModelGuard(composition.model, guardOptions);
      this.active = {
        request: buildRequest,
        composition,
        model,
        controller,
      };
      const saved = await this.saveMessages([...request.messages], {
        signal: composition.turn.signal,
      });
      let response: Response | null = null;
      if (
        saved.status === 'completed' &&
        !composition.turn.isDisposed() &&
        !requestAborted(request) &&
        request.isStale?.() !== true
      ) {
        const candidate = await composition.getCommittedResponse();
        if (
          !composition.turn.isDisposed() &&
          !requestAborted(request) &&
          request.isStale?.() !== true
        ) {
          response = candidate ?? null;
        }
      }
      result = {
        ...saved,
        response,
        ...(saved.status === 'error' && runtimeGuardFailureCode !== undefined
          ? { runtimeGuardFailureCode }
          : {}),
      };
    } catch (error) {
      hasPrimaryError = true;
      primaryError = error;
    } finally {
      cleanup?.run();
      cleanupError = cleanup?.error();
      unlinkCleanup?.();
      unlinkAbort();
      controller.abort();
      this.active = undefined;
    }
    if (hasPrimaryError) throw thrownError(primaryError);
    if (cleanupError !== undefined) throw thrownError(cleanupError);
    if (result === undefined) throw new RuntimeThinkConnectionError('COMPOSITION_INVALID');
    return result;
  }

  cancel(): void {
    const active = this.active;
    if (active === undefined) return;
    active.controller.abort();
  }

  isActive(): boolean {
    return this.active !== undefined;
  }

  private requireActive(): ActiveTurn<Response> {
    const active = this.active;
    if (active === undefined) throw new RuntimeThinkConnectionError('RUNTIME_UNCONFIGURED');
    if (!('model' in active)) throw new RuntimeThinkConnectionError('TURN_NOT_ACTIVE');
    return active;
  }

  private assertTurnUsable(active: ActiveTurn<Response>): void {
    if (active.composition.turn.isDisposed() || active.request.signal?.aborted === true) {
      throw new RuntimeThinkConnectionError('CANCELLED');
    }
    if (active.request.isStale?.() === true) {
      throw new RuntimeThinkConnectionError('STALE_TURN');
    }
  }
}

export const createRuntimeThinkConnection = <Response = unknown>(
  options: RuntimeThinkConnectionOptions<Response>,
): RuntimeThinkConnection<Response> => new RuntimeThinkConnection(options);
