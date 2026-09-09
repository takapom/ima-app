import {
  Think,
  type PrepareStepContext,
  type ToolCallResultContext,
  type ToolCallContext,
  type TurnContext,
} from '@cloudflare/think';
import type { Session } from 'agents/experimental/memory/session';
import {
  stepCountIs,
  tool,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  type StopCondition,
  type ToolExecutionOptions,
  type ToolSet,
  type UIMessage,
} from 'ai';
import {
  GetPlaceDetailsInputSchema,
  SearchPlacesInputSchema,
  SubmitCardsInputSchema,
} from '@ima/core';
import type {
  GetPlaceDetailsOutput,
  HarnessContext,
  Result,
  SearchPlacesOutput,
  SubmitCardsPortResult,
} from '@ima/core';
import * as v from 'valibot';
import {
  getPlaceDetailsEnvelopeSchema,
  searchPlacesEnvelopeSchema,
  submitCardsEnvelopeSchema,
} from '../runtime-gate/runtime-gate-contract';
import {
  RuntimeGateCore,
  runtimeGateCancellation,
  runtimeGateExecutionContext,
  runtimeGateHarnessContext,
} from '../runtime-gate/runtime-gate-core';
import {
  DENIED_MARKER,
  modelFor,
  normalizeScenario,
  TURN_CONSTRAINTS,
  type RuntimeGateModel,
  type RuntimeGateModelReport,
  type RuntimeGateScenario,
} from '../runtime-gate/runtime-gate-provider';
import {
  wrapRuntimeGateStepBuffer,
  type RuntimeGateStepReport,
} from '../runtime-gate/runtime-gate-step';
import { modelWithCanary } from './think-runtime-canary';
import {
  projectThinkRuntimeCurrentTurnContent,
  projectThinkRuntimeEphemeralResults,
  waitForThinkRuntimeCancellation,
  type ThinkRuntimeEphemeralToolCall,
  type ThinkRuntimeEphemeralToolResult,
} from './think-runtime-loop';
import {
  createThinkRuntimeTransform,
  type ThinkRuntimeToolCallObserver,
  type ThinkRuntimeToolResultObserver,
  type ThinkRuntimeTransformReport,
} from './think-runtime-transform';
import {
  buildThinkRuntimePublicReport,
  saveResult,
  TOOL_ALLOWLIST,
  type RuntimeGateDetailsEnvelope,
  type RuntimeGateSearchEnvelope,
  type RuntimeGateSubmitEnvelope,
  type RuntimeGateToolInput,
  type RuntimeGateToolName,
  type ThinkRuntimeLogEntry,
  type ThinkRuntimePublicReport,
  type ThinkRuntimeResult,
  type ThinkRuntimeToolExecution,
} from './think-runtime-report';
import {
  emptyThinkRuntimeReplay,
  queryRevision,
  queryText,
  resolveThinkRuntimeReplay,
  storeThinkRuntimeReplay,
  type ThinkRuntimeReplayReport,
  type ThinkRuntimeState,
} from './think-runtime-replay';
import { handleThinkRetentionRequest } from './retention/think-retention-operations';
import { ThinkRetentionRuntimeSurface } from './retention/think-retention-runtime';

export type { ThinkRuntimePublicReport } from './think-runtime-report';

function isJsonValue(value: unknown): value is JSONValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function validRawToolInput(toolName: string, envelope: Record<string, unknown>): boolean {
  const input = envelope.input;
  if (toolName === 'search_places') {
    return v.safeParse(SearchPlacesInputSchema, input).success;
  }
  if (toolName === 'get_place_details') {
    return v.safeParse(GetPlaceDetailsInputSchema, input).success;
  }
  if (toolName === 'submit_cards') {
    return v.safeParse(SubmitCardsInputSchema, input).success;
  }
  return false;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ThinkRuntimeGateAgent extends Think<Cloudflare.Env, ThinkRuntimeState> {
  override workspaceBash = false;
  override includeMcpTools = false;
  override fetchTools = false as const;
  override maxSteps = 6;
  initialState: ThinkRuntimeState = {};

  private core!: RuntimeGateCore;
  private harnessContext!: HarnessContext;
  private model!: RuntimeGateModel;
  private modelReport!: RuntimeGateModelReport;
  private scenario: RuntimeGateScenario = 'sequence';
  private canary: string | null = null;
  private stepReport!: RuntimeGateStepReport;
  private transformReport!: ThinkRuntimeTransformReport;
  private ephemeralToolCalls = new Map<string, ThinkRuntimeEphemeralToolCall>();
  private ephemeralToolResults = new Map<string, ThinkRuntimeEphemeralToolResult>();
  private turnModelMessageStart = 0;
  private nativeSdkStarted = false;
  private beforeTurnSteps = 0;
  private beforeStepNumbers: number[] = [];
  private beforeToolCalls: string[] = [];
  private toolExecutions: ThinkRuntimeToolExecution[] = [];
  private logEntries: ThinkRuntimeLogEntry[] = [];
  private sessionHistoryMarkerPresent = false;
  private sessionHistoryCanaryPresent = false;
  private ephemeralResultsProjected = 0;
  private replayReport: ThinkRuntimeReplayReport = emptyThinkRuntimeReplay();
  private nativeContentForTurn: string | null = null;
  private readonly retention: ThinkRetentionRuntimeSurface;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.retention = new ThinkRetentionRuntimeSurface(this, ctx.storage, (policy) =>
      this.initialize(
        policy === 'failure' ? 'structured-error' : policy === 'disconnect' ? 'cancel' : 'sequence',
      ),
    );
    this.initialize('sequence');
  }

  private initialize(
    scenario: RuntimeGateScenario,
    canary: string | null = null,
    nativeContent: string | null = null,
  ): void {
    this.scenario = scenario;
    this.canary = canary;
    this.nativeContentForTurn = nativeContent;
    this.core = new RuntimeGateCore();
    this.harnessContext = runtimeGateHarnessContext({
      threadId: 'think-runtime-fixture',
      turnId: 'turn-think-runtime',
      revision: 1,
    });
    this.modelReport = { calls: 0, requests: [] };
    this.stepReport = {
      bufferedSteps: 0,
      acceptedSteps: [],
      rejectedSteps: [],
      providerOptionsSeen: [],
    };
    this.transformReport = {
      inputParts: 0,
      markerPartsBefore: 0,
      markerPartsAfter: 0,
      redactedTextParts: 0,
      redactedReasoningParts: 0,
      redactedToolInputParts: 0,
      redactedToolCallParts: 0,
      redactedToolResultParts: 0,
      redactedToolErrorParts: 0,
      rejectedPartTypes: [],
    };
    const baseModel = modelFor(scenario, this.modelReport, () => this.nativeContentForTurn);
    const checkedModel = wrapRuntimeGateStepBuffer(baseModel, this.stepReport, {
      maxMs: scenario === 'timeout' ? 50 : 2_000,
    });
    this.model = canary === null ? checkedModel : modelWithCanary(checkedModel, canary);
    this.ephemeralToolCalls.clear();
    this.ephemeralToolResults.clear();
    this.turnModelMessageStart = 0;
    this.nativeSdkStarted = false;
    this.beforeTurnSteps = 0;
    this.beforeStepNumbers = [];
    this.beforeToolCalls = [];
    this.toolExecutions = [];
    this.logEntries = [];
    this.sessionHistoryMarkerPresent = false;
    this.sessionHistoryCanaryPresent = false;
    this.ephemeralResultsProjected = 0;
    this.replayReport = emptyThinkRuntimeReplay('run');
  }

  override getModel(): LanguageModel {
    return this.model;
  }

  override configureSession(session: Session): Session {
    return session.onCompaction((messages) =>
      Promise.resolve(
        this.retention.compactionResult(messages, 'untrusted SDK compaction summary'),
      ),
    );
  }

  private recordTool(
    name: RuntimeGateToolName,
    input: RuntimeGateToolInput,
    options: ToolExecutionOptions,
  ): string {
    const callId = `think-runtime-call-${this.toolExecutions.length + 1}`;
    this.toolExecutions.push({ name, input, abortSignalPassed: options.abortSignal !== undefined });
    return callId;
  }

  override getTools() {
    return {
      search_places: tool<RuntimeGateSearchEnvelope, Result<SearchPlacesOutput>>({
        description: 'Search fixture places.',
        inputSchema: searchPlacesEnvelopeSchema,
        execute: async (envelope, options) => {
          const callId = this.recordTool('search_places', envelope.input, options);
          if (this.scenario === 'structured-error') throw new Error(DENIED_MARKER);
          if (this.scenario === 'cancel')
            await waitForThinkRuntimeCancellation(options.abortSignal);
          return this.core.search(
            envelope.input,
            this.harnessContext,
            runtimeGateExecutionContext(this.harnessContext, 'search_places', callId),
            runtimeGateCancellation(options.abortSignal),
          );
        },
      }),
      get_place_details: tool<RuntimeGateDetailsEnvelope, Result<GetPlaceDetailsOutput>>({
        description: 'Read exact field observations for a fixture candidate.',
        inputSchema: getPlaceDetailsEnvelopeSchema,
        execute: async (envelope, options) => {
          const callId = this.recordTool('get_place_details', envelope.input, options);
          return this.core.read(
            envelope.input,
            this.harnessContext,
            runtimeGateExecutionContext(this.harnessContext, 'get_place_details', callId),
            runtimeGateCancellation(options.abortSignal),
          );
        },
      }),
      submit_cards: tool<RuntimeGateSubmitEnvelope, SubmitCardsPortResult>({
        description: 'Submit grounded cards with observation evidence.',
        inputSchema: submitCardsEnvelopeSchema,
        execute: async (envelope, options) => {
          const callId = this.recordTool('submit_cards', envelope.input, options);
          return this.core.submit(
            envelope.input,
            runtimeGateExecutionContext(this.harnessContext, 'submit_cards', callId),
            runtimeGateCancellation(options.abortSignal),
          );
        },
      }),
    } satisfies ToolSet;
  }

  private observeToolCall: ThinkRuntimeToolCallObserver = (toolCallId, toolName, input) => {
    if (!isJsonObject(input)) return;
    this.ephemeralToolCalls.set(toolCallId, { toolCallId, toolName, input });
  };

  private observeToolResult: ThinkRuntimeToolResultObserver = (
    toolCallId,
    toolName,
    _input,
    output,
  ) => {
    if (!isJsonValue(output)) return;
    this.ephemeralToolResults.set(toolCallId, { toolCallId, toolName, output });
  };

  override beforeTurn(ctx: TurnContext) {
    this.beforeTurnSteps += 1;
    this.turnModelMessageStart = ctx.messages.length;
    const stopAfterCommit: StopCondition<ToolSet> = () => this.core.report.commits.length > 0;
    const stopAfterRepairLimit: StopCondition<ToolSet> = () => this.core.report.repairCount >= 3;
    return {
      activeTools: [...TOOL_ALLOWLIST],
      maxSteps: 6,
      stopWhen: [stopAfterCommit, stopAfterRepairLimit, stepCountIs(6)],
      maxRetries: 0,
      providerOptions: {
        m04: {
          turnConstraints: TURN_CONSTRAINTS,
          requireEnvelope: true,
        },
      },
      experimental_transform: createThinkRuntimeTransform(
        this.transformReport,
        this.observeToolResult,
        this.observeToolCall,
      ),
    };
  }

  private projectEphemeralResults(messages: ModelMessage[]): ModelMessage[] {
    const start = Math.min(this.turnModelMessageStart, messages.length);
    const projected = projectThinkRuntimeEphemeralResults(
      messages,
      start,
      this.ephemeralToolCalls,
      this.ephemeralToolResults,
    );
    this.ephemeralResultsProjected += projected.projected;
    return projected.messages;
  }

  override beforeStep(ctx: PrepareStepContext) {
    this.beforeStepNumbers.push(ctx.stepNumber);
    const currentTurnMessages = projectThinkRuntimeCurrentTurnContent(
      ctx.messages,
      this.turnModelMessageStart,
      this.nativeContentForTurn,
    );
    const messages =
      ctx.stepNumber === 0
        ? currentTurnMessages
        : this.projectEphemeralResults(currentTurnMessages);
    return {
      activeTools: [...TOOL_ALLOWLIST],
      ...(this.nativeContentForTurn !== null || ctx.stepNumber !== 0 ? { messages } : {}),
    };
  }

  override beforeToolCall(ctx: ToolCallContext) {
    this.beforeToolCalls.push(ctx.toolName);
    if (!TOOL_ALLOWLIST.includes(ctx.toolName as RuntimeGateToolName)) {
      return { action: 'block' as const, reason: 'M04_TOOL_NOT_ALLOWLISTED' };
    }
    const rawCall = this.ephemeralToolCalls.get(ctx.toolCallId);
    if (rawCall === undefined) return { action: 'allow' as const };
    return validRawToolInput(ctx.toolName, rawCall.input)
      ? { action: 'allow' as const, input: rawCall.input }
      : { action: 'block' as const, reason: 'M04_TOOL_INPUT_INVALID' };
  }

  /** Think's logger hooks receive raw tool outcomes; only emit stable metadata. */
  override afterToolCall(ctx: ToolCallResultContext): void {
    const entry: ThinkRuntimeLogEntry = {
      toolName: ctx.toolName,
      success: ctx.success,
      errorCode: ctx.success ? null : 'UPSTREAM_UNAVAILABLE',
    };
    this.logEntries.push(entry);
    console.log('[M04_LOG_AUDIT]', JSON.stringify(entry));
  }

  private report(result: ThinkRuntimeResult | null): ThinkRuntimePublicReport {
    return buildThinkRuntimePublicReport({
      scenario: this.scenario,
      result,
      messages: this.messages,
      nativeSdkStarted: this.nativeSdkStarted,
      replay: this.replayReport,
      beforeTurnSteps: this.beforeTurnSteps,
      beforeStepNumbers: this.beforeStepNumbers,
      beforeToolCalls: this.beforeToolCalls,
      toolExecutions: this.toolExecutions,
      logEntries: this.logEntries,
      model: this.modelReport,
      core: this.core.report,
      step: this.stepReport,
      transform: this.transformReport,
      ephemeralResultsCaptured: this.ephemeralToolResults.size,
      ephemeralResultsProjected: this.ephemeralResultsProjected,
      canary: this.canary,
      sessionHistoryMarkerPresent: this.sessionHistoryMarkerPresent,
      sessionHistoryCanaryPresent: this.sessionHistoryCanaryPresent,
      storageSql: this.ctx.storage.sql,
    });
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const retentionResponse = await handleThinkRetentionRequest(request, this.retention);
    if (retentionResponse !== undefined) return retentionResponse;
    if (url.pathname === '/replay' && request.method === 'GET') {
      const replay = await resolveThinkRuntimeReplay(url, this.state.replay, this.beforeTurnSteps);
      this.initialize(this.scenario);
      this.replayReport = replay.report;
      return Response.json(this.report(replay.result));
    }
    if (url.pathname !== '/run' || request.method !== 'GET') {
      return new Response('Not Found', { status: 404 });
    }

    const canaryValue = url.searchParams.get('canary');
    const canary = canaryValue === null ? null : canaryValue.slice(0, 128);
    const payload = queryText(url, 'content', 'same payload');
    this.initialize(normalizeScenario(url.searchParams.get('case')), canary, payload);
    const idempotencyKey = queryText(url, 'idempotencyKey', 'think-runtime-key');
    const turnId = queryText(url, 'turnId', 'turn-think-runtime');
    const revision = queryRevision(url);
    this.harnessContext = runtimeGateHarnessContext({
      threadId: queryText(url, 'threadId', 'think-runtime-fixture'),
      turnId,
      revision,
    });
    const abortController = this.scenario === 'cancel' ? new AbortController() : undefined;
    const cancelTimer =
      abortController === undefined
        ? undefined
        : setTimeout(() => abortController.abort('M04_CANCEL'), 10);
    this.nativeSdkStarted = true;

    let result: ThinkRuntimeResult | null = null;
    try {
      const saved = await this.retention.saveMessages(
        [
          {
            id: `think-runtime-user-${crypto.randomUUID()}`,
            role: 'user',
            parts: [{ type: 'text', text: payload }],
          } satisfies UIMessage,
        ],
        abortController === undefined ? undefined : { signal: abortController.signal },
      );
      result = saveResult(saved);
    } catch (error) {
      result = {
        requestId: `think-runtime-${crypto.randomUUID()}`,
        status: 'error',
        error: errorText(error),
      };
    } finally {
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);
      this.nativeContentForTurn = null;
    }

    const commit = this.core.report.commits.at(-1);
    if (result?.status === 'completed' && commit !== undefined) {
      this.replayReport = await storeThinkRuntimeReplay(
        {
          idempotencyKey,
          payload,
          turnId,
          revision,
          responseId: `response-think-runtime-${this.core.report.commits.length}`,
          candidateIds: [...commit.candidateIds],
          evidenceIds: [...commit.evidenceIds],
        },
        (state) => this.setState(state),
      );
    }

    const sessionHistory = JSON.stringify(await this.session.getHistory());
    this.sessionHistoryMarkerPresent = sessionHistory.includes(DENIED_MARKER);
    this.sessionHistoryCanaryPresent =
      this.canary === null ? false : sessionHistory.includes(this.canary);
    return Response.json(this.report(result));
  }
}

export { DENIED_MARKER, TOOL_ALLOWLIST };
