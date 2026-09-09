import { Think, type PrepareStepContext } from '@cloudflare/think';
import type { Session } from 'agents/experimental/memory/session';
import { tool, type LanguageModel, type ModelMessage, type ToolSet, type UIMessage } from 'ai';
import * as v from 'valibot';
import {
  GetPlaceDetailsInputSchema,
  SearchPlacesInputSchema,
  SubmitCardsInputSchema,
} from '@ima/core';
import {
  DENIED_MARKER,
  REQUIRED_STORE_FACT,
  THINK_GATE_TOOLS,
  TOOL_RESULT_PAYLOAD,
  createThinkGateModel,
  type ThinkGateModelReport,
  type ThinkGateScenario,
} from './think-gate-provider';
import { wrapThinkGateStepBuffer, type ThinkGateStepReport } from './think-gate-step';
import {
  createThinkGateStreamTransform,
  type ThinkGateToolResultObserver,
  type ThinkGateStreamTransformReport,
} from './think-gate-transform';
import {
  getPlaceDetailsInputSchema,
  searchPlacesInputSchema,
  submitCardsInputSchema,
} from './think-gate-contract';
import {
  markerRowsByTable,
  type MarkerTableObservation,
  sessionWithPersistencePolicy,
} from './think-gate-session';

export type ThinkGateMode =
  | 'raw-hooks'
  | 'buffered-model'
  | 'persistence-policy'
  | 'stream-transform'
  | 'stream-transform-ephemeral';

export type ThinkGatePublicReport = {
  mode: ThinkGateMode;
  scenario: ThinkGateScenario;
  resultStatus: string | null;
  error: string | null;
  model: ThinkGateModelReport;
  beforeTurnSteps: number;
  beforeStepNumbers: number[];
  beforeToolCalls: string[];
  toolExecutions: string[];
  step: ThinkGateStepReport;
  liveCacheMarkerPresent: boolean;
  sessionHistoryMarkerPresent: boolean;
  messageCount: number;
  configureSessionCalls: number;
  storageMarkerCounts: Record<string, MarkerTableObservation>;
  streamTransform: ThinkGateStreamTransformReport;
  ephemeralToolResultCaptured: boolean;
  ephemeralToolResultProjected: boolean;
};

type EphemeralToolResult = {
  toolCallId: string;
  toolName: string;
  storeName: string;
  payload: string;
};

function parseEphemeralToolResult(
  value: unknown,
): Omit<EphemeralToolResult, 'toolCallId' | 'toolName'> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!('storeName' in value) || !('payload' in value)) return null;
  if (typeof value.storeName !== 'string' || typeof value.payload !== 'string') return null;
  return { storeName: value.storeName, payload: value.payload };
}

function schemaChecked<T>(schema: v.GenericSchema<unknown, T>, value: unknown): boolean {
  return v.safeParse(schema, value).success;
}

export class ThinkGateAgent extends Think {
  override workspaceBash = false;
  override includeMcpTools = false;
  override fetchTools = false as const;
  override maxSteps = 1;

  private model!: LanguageModel;
  private mode: ThinkGateMode = 'raw-hooks';
  private scenario: ThinkGateScenario = 'mixed-step';
  private modelReport: ThinkGateModelReport = { calls: 0, requests: [] };
  private stepReport: ThinkGateStepReport = {
    bufferedSteps: 0,
    acceptedSteps: 0,
    rejectedCodes: [],
    bufferedBytes: [],
  };
  private streamTransformReport: ThinkGateStreamTransformReport = {
    inputParts: 0,
    markerParts: 0,
    markerPartsAfterTransform: 0,
    redactedParts: 0,
    redactedTextParts: 0,
    redactedToolResultParts: 0,
  };
  private beforeTurnSteps = 0;
  private beforeStepNumbers: number[] = [];
  private beforeToolCalls: string[] = [];
  private toolExecutions: string[] = [];
  private configureSessionCalls = 0;
  private sessionHistoryMarkerPresent = false;
  private ephemeralToolResult: EphemeralToolResult | null = null;
  private ephemeralToolResultCaptured = false;
  private ephemeralToolResultProjected = false;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.prepare('raw-hooks', 'mixed-step');
  }

  private prepare(mode: ThinkGateMode, scenario: ThinkGateScenario): void {
    this.mode = mode;
    this.scenario = scenario;
    this.modelReport = { calls: 0, requests: [] };
    this.stepReport = {
      bufferedSteps: 0,
      acceptedSteps: 0,
      rejectedCodes: [],
      bufferedBytes: [],
    };
    this.streamTransformReport = {
      inputParts: 0,
      markerParts: 0,
      markerPartsAfterTransform: 0,
      redactedParts: 0,
      redactedTextParts: 0,
      redactedToolResultParts: 0,
    };
    this.maxSteps = mode === 'stream-transform' || mode === 'stream-transform-ephemeral' ? 2 : 1;
    this.beforeTurnSteps = 0;
    this.beforeStepNumbers = [];
    this.beforeToolCalls = [];
    this.toolExecutions = [];
    this.sessionHistoryMarkerPresent = false;
    this.ephemeralToolResult = null;
    this.ephemeralToolResultCaptured = false;
    this.ephemeralToolResultProjected = false;
    const rawModel = createThinkGateModel(scenario, this.modelReport);
    this.model =
      mode === 'buffered-model' ? wrapThinkGateStepBuffer(rawModel, this.stepReport) : rawModel;
  }

  override getModel(): LanguageModel {
    return this.model;
  }

  override configureSession(_session: Session): Session {
    this.configureSessionCalls += 1;
    return sessionWithPersistencePolicy(this);
  }

  override getTools(): ToolSet {
    return {
      search_places: tool({
        description: 'Search fixture places.',
        inputSchema: searchPlacesInputSchema,
        execute: (input) => {
          if (!schemaChecked(SearchPlacesInputSchema, input)) {
            throw new Error('THINK_GATE_SEARCH_CORE_SCHEMA_MISMATCH');
          }
          this.toolExecutions.push('search_places');
          return { status: 'ok' };
        },
      }),
      get_place_details: tool({
        description: 'Read fixture place details.',
        inputSchema: getPlaceDetailsInputSchema,
        execute: (input) => {
          if (!schemaChecked(GetPlaceDetailsInputSchema, input)) {
            throw new Error('THINK_GATE_DETAILS_CORE_SCHEMA_MISMATCH');
          }
          this.toolExecutions.push('get_place_details');
          return this.mode === 'stream-transform' || this.mode === 'stream-transform-ephemeral'
            ? { status: 'ok', storeName: REQUIRED_STORE_FACT, payload: TOOL_RESULT_PAYLOAD }
            : { status: 'ok' };
        },
      }),
      submit_cards: tool({
        description: 'Submit fixture cards.',
        inputSchema: submitCardsInputSchema,
        execute: (input) => {
          if (!schemaChecked(SubmitCardsInputSchema, input)) {
            throw new Error('THINK_GATE_SUBMIT_CORE_SCHEMA_MISMATCH');
          }
          this.toolExecutions.push('submit_cards');
          return { status: 'ok' };
        },
      }),
    };
  }

  override beforeTurn() {
    this.beforeTurnSteps += 1;
    const config = {
      activeTools: [...THINK_GATE_TOOLS],
      maxSteps: this.maxSteps,
    };
    const onToolResult: ThinkGateToolResultObserver | undefined =
      this.mode === 'stream-transform-ephemeral'
        ? (toolCallId, toolName, output) => {
            const parsed = parseEphemeralToolResult(output);
            if (parsed === null) return;
            this.ephemeralToolResult = { toolCallId, toolName, ...parsed };
            this.ephemeralToolResultCaptured = true;
          }
        : undefined;
    return this.mode === 'stream-transform' || this.mode === 'stream-transform-ephemeral'
      ? {
          ...config,
          experimental_transform: createThinkGateStreamTransform(
            this.streamTransformReport,
            onToolResult,
          ),
        }
      : config;
  }

  private projectEphemeralToolResult(messages: ModelMessage[]): ModelMessage[] {
    const result = this.ephemeralToolResult;
    if (result === null) return messages;
    let projected = false;
    const projectedMessages = messages.map((message) => {
      if (message.role !== 'tool') return message;
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== 'tool-result' || part.toolCallId !== result.toolCallId) return part;
          projected = true;
          return {
            ...part,
            output: {
              type: 'json' as const,
              value: {
                status: 'ok',
                storeName: result.storeName,
                payload: result.payload,
              },
            },
          };
        }),
      };
    });
    this.ephemeralToolResultProjected ||= projected;
    return projectedMessages;
  }

  override beforeStep(ctx: PrepareStepContext) {
    this.beforeStepNumbers.push(ctx.stepNumber);
    if (this.mode === 'stream-transform-ephemeral' && ctx.stepNumber > 0) {
      return {
        activeTools: [...THINK_GATE_TOOLS],
        messages: this.projectEphemeralToolResult(ctx.messages),
      };
    }
    return { activeTools: [...THINK_GATE_TOOLS] };
  }

  override beforeToolCall(ctx: { toolName: string }) {
    this.beforeToolCalls.push(ctx.toolName);
    return { action: 'allow' as const };
  }

  private report(resultStatus: string | null, error: string | null): ThinkGatePublicReport {
    const serialized = JSON.stringify(this.messages);
    return {
      mode: this.mode,
      scenario: this.scenario,
      resultStatus,
      error,
      model: this.modelReport,
      beforeTurnSteps: this.beforeTurnSteps,
      beforeStepNumbers: this.beforeStepNumbers,
      beforeToolCalls: this.beforeToolCalls,
      toolExecutions: this.toolExecutions,
      step: this.stepReport,
      liveCacheMarkerPresent: serialized.includes(DENIED_MARKER),
      sessionHistoryMarkerPresent: this.sessionHistoryMarkerPresent,
      messageCount: this.messages.length,
      configureSessionCalls: this.configureSessionCalls,
      storageMarkerCounts: markerRowsByTable(this.ctx.storage.sql),
      streamTransform: this.streamTransformReport,
      ephemeralToolResultCaptured: this.ephemeralToolResultCaptured,
      ephemeralToolResultProjected: this.ephemeralToolResultProjected,
    };
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/run' || request.method !== 'GET') {
      return new Response('Not Found', { status: 404 });
    }

    const mode = url.searchParams.get('mode');
    const selectedMode: ThinkGateMode =
      mode === 'buffered-model'
        ? 'buffered-model'
        : mode === 'persistence-policy'
          ? 'persistence-policy'
          : mode === 'stream-transform'
            ? 'stream-transform'
            : mode === 'stream-transform-ephemeral'
              ? 'stream-transform-ephemeral'
              : 'raw-hooks';
    this.prepare(
      selectedMode,
      selectedMode === 'persistence-policy'
        ? 'final-sentinel'
        : selectedMode === 'stream-transform'
          ? 'tool-result-sentinel'
          : selectedMode === 'stream-transform-ephemeral'
            ? 'tool-result-sentinel'
            : 'mixed-step',
    );

    try {
      const result = await this.saveMessages([
        {
          id: `think-gate-user-${crypto.randomUUID()}`,
          role: 'user',
          parts: [{ type: 'text', text: 'Run the mixed read and submit fixture.' }],
        } satisfies UIMessage,
      ]);
      this.sessionHistoryMarkerPresent = JSON.stringify(await this.session.getHistory()).includes(
        DENIED_MARKER,
      );
      return Response.json(this.report(result.status, result.error ?? null));
    } catch (error) {
      return Response.json(
        this.report(null, error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
