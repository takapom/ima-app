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
  GetPlaceDetailsInput,
  GetPlaceDetailsOutput,
  HarnessContext,
  Result,
  SearchPlacesInput,
  SearchPlacesOutput,
  SubmitCardsInput,
  SubmitCardsPortResult,
} from '@ima/core';
import * as v from 'valibot';
import {
  getPlaceDetailsEnvelopeSchema,
  searchPlacesEnvelopeSchema,
  submitCardsEnvelopeSchema,
  type RuntimeGateToolEnvelope,
} from '../runtime-gate/runtime-gate-contract';
import {
  RuntimeGateCore,
  runtimeGateCancellation,
  runtimeGateExecutionContext,
  runtimeGateHarnessContext,
  type RuntimeGateCoreReport,
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
import { markerRowsByTable, type ThinkRuntimeTableObservation } from './think-runtime-audit';
import { modelWithCanary } from './think-runtime-canary';
import {
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

type RuntimeGateToolName = 'search_places' | 'get_place_details' | 'submit_cards';
type RuntimeGateToolInput = SearchPlacesInput | GetPlaceDetailsInput | SubmitCardsInput;
type RuntimeGateSearchEnvelope = RuntimeGateToolEnvelope<SearchPlacesInput>;
type RuntimeGateDetailsEnvelope = RuntimeGateToolEnvelope<GetPlaceDetailsInput>;
type RuntimeGateSubmitEnvelope = RuntimeGateToolEnvelope<SubmitCardsInput>;

type ThinkRuntimeToolExecution = {
  name: RuntimeGateToolName;
  input: RuntimeGateToolInput;
  abortSignalPassed: boolean;
};

type ThinkRuntimeResult = {
  requestId: string;
  status: string;
  error: string | null;
};

type ThinkRuntimeLogEntry = {
  toolName: string;
  success: boolean;
  errorCode: string | null;
};

export type ThinkRuntimePublicReport = {
  scenario: RuntimeGateScenario;
  result: ThinkRuntimeResult | null;
  nativeSdkStarted: boolean;
  toolAllowlist: RuntimeGateToolName[];
  beforeTurnSteps: number;
  beforeStepNumbers: number[];
  beforeToolCalls: string[];
  toolExecutions: ThinkRuntimeToolExecution[];
  logEntries: ThinkRuntimeLogEntry[];
  model: RuntimeGateModelReport;
  core: RuntimeGateCoreReport;
  step: RuntimeGateStepReport;
  transform: ThinkRuntimeTransformReport;
  ephemeralResultsCaptured: number;
  ephemeralResultsProjected: number;
  canary: {
    value: string;
    liveCacheMarkerPresent: boolean;
    sessionHistoryMarkerPresent: boolean;
    storageMarkerCounts: Record<string, ThinkRuntimeTableObservation>;
  } | null;
  persistence: {
    liveCacheMarkerPresent: boolean;
    sessionHistoryMarkerPresent: boolean;
    storageMarkerCounts: Record<string, ThinkRuntimeTableObservation>;
  };
};

const TOOL_ALLOWLIST: RuntimeGateToolName[] = [
  'search_places',
  'get_place_details',
  'submit_cards',
];

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

function saveResult(result: {
  requestId: string;
  status: string;
  error?: unknown;
}): ThinkRuntimeResult {
  return {
    requestId: result.requestId,
    status: result.status,
    error: result.error === undefined ? null : errorText(result.error),
  };
}

export class ThinkRuntimeGateAgent extends Think {
  override workspaceBash = false;
  override includeMcpTools = false;
  override fetchTools = false as const;
  override maxSteps = 6;

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

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.initialize('sequence');
  }

  private initialize(scenario: RuntimeGateScenario, canary: string | null = null): void {
    this.scenario = scenario;
    this.canary = canary;
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
    const baseModel = modelFor(scenario, this.modelReport);
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
  }

  override getModel(): LanguageModel {
    return this.model;
  }

  override configureSession(session: Session): Session {
    return session;
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
    return {
      activeTools: [...TOOL_ALLOWLIST],
      ...(ctx.stepNumber === 0 ? {} : { messages: this.projectEphemeralResults(ctx.messages) }),
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
    const serialized = JSON.stringify(this.messages);
    return {
      scenario: this.scenario,
      result,
      nativeSdkStarted: this.nativeSdkStarted,
      toolAllowlist: [...TOOL_ALLOWLIST],
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
      canary:
        this.canary === null
          ? null
          : {
              value: this.canary,
              liveCacheMarkerPresent: serialized.includes(this.canary),
              sessionHistoryMarkerPresent: this.sessionHistoryCanaryPresent,
              storageMarkerCounts: markerRowsByTable(this.ctx.storage.sql, this.canary),
            },
      persistence: {
        liveCacheMarkerPresent: serialized.includes(DENIED_MARKER),
        sessionHistoryMarkerPresent: this.sessionHistoryMarkerPresent,
        storageMarkerCounts: markerRowsByTable(this.ctx.storage.sql, DENIED_MARKER),
      },
    };
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/run' || request.method !== 'GET') {
      return new Response('Not Found', { status: 404 });
    }

    const canaryValue = url.searchParams.get('canary');
    const canary = canaryValue === null ? null : canaryValue.slice(0, 128);
    this.initialize(normalizeScenario(url.searchParams.get('case')), canary);
    const payload = url.searchParams.get('content')?.slice(0, 256) ?? 'same payload';
    const abortController = this.scenario === 'cancel' ? new AbortController() : undefined;
    const cancelTimer =
      abortController === undefined
        ? undefined
        : setTimeout(() => abortController.abort('M04_CANCEL'), 10);
    this.nativeSdkStarted = true;

    let result: ThinkRuntimeResult | null = null;
    try {
      const saved = await this.saveMessages(
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
    }

    const sessionHistory = JSON.stringify(await this.session.getHistory());
    this.sessionHistoryMarkerPresent = sessionHistory.includes(DENIED_MARKER);
    this.sessionHistoryCanaryPresent =
      this.canary === null ? false : sessionHistory.includes(this.canary);
    return Response.json(this.report(result));
  }
}

export { DENIED_MARKER, TOOL_ALLOWLIST };
