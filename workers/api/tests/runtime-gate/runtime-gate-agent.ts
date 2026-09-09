import {
  AIChatAgent,
  type ChatMessage,
  type OnChatMessageOptions,
  type SaveMessagesResult,
} from '@cloudflare/ai-chat';
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type GenerateTextOnFinishCallback,
  type StopCondition,
  type ToolExecutionOptions,
  type ToolSet,
} from 'ai';
import type { AgentContext } from 'agents';
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
import type { UIMessage } from 'ai';
import {
  getPlaceDetailsEnvelopeSchema,
  searchPlacesEnvelopeSchema,
  submitCardsEnvelopeSchema,
  type RuntimeGateToolEnvelope,
} from './runtime-gate-contract';
import {
  RuntimeGateCore,
  runtimeGateCancellation,
  runtimeGateDefaultContext,
  runtimeGateExecutionContext,
  runtimeGateHarnessContext,
} from './runtime-gate-core';
import {
  modelFor,
  normalizeScenario,
  DENIED_MARKER,
  TURN_CONSTRAINTS,
  type RuntimeGateModel,
  type RuntimeGateModelReport,
  type RuntimeGateScenario,
} from './runtime-gate-provider';
import { wrapRuntimeGateStepBuffer, type RuntimeGateStepReport } from './runtime-gate-step';
import { sanitizeSseResponse, type RuntimeGateSseEvent } from './runtime-gate-sse';
import {
  RuntimeGateRetentionSurface,
  type RuntimeGateRetentionHost,
} from './runtime-gate-retention';
import type {
  RuntimeGatePublicReport,
  RuntimeGateReplayRecord,
  RuntimeGateReplayReport,
  RuntimeGateState,
  RuntimeGateToolExecution,
  RuntimeGateToolInput,
  RuntimeGateToolName,
} from './runtime-gate-report';

export type {
  RuntimeGatePublicReport,
  RuntimeGateReplayCommit,
  RuntimeGateReplayRecord,
  RuntimeGateReplayReport,
  RuntimeGateState,
  RuntimeGateToolExecution,
  RuntimeGateToolInput,
  RuntimeGateToolName,
} from './runtime-gate-report';

type RuntimeGateSearchEnvelope = RuntimeGateToolEnvelope<SearchPlacesInput>;
type RuntimeGateDetailsEnvelope = RuntimeGateToolEnvelope<GetPlaceDetailsInput>;
type RuntimeGateSubmitEnvelope = RuntimeGateToolEnvelope<SubmitCardsInput>;

const TOOL_ALLOWLIST = ['search_places', 'get_place_details', 'submit_cards'] as const;

function saveResult(result: SaveMessagesResult | undefined) {
  if (result === undefined) return null;
  return {
    requestId: result.requestId,
    status: result.status,
    error: result.error ?? null,
  };
}

function emptyReplayReport(
  action: RuntimeGateReplayReport['action'] = 'none',
): RuntimeGateReplayReport {
  return {
    action,
    outcome: 'none',
    idempotencyKey: null,
    turnId: null,
    requestedRevision: null,
    storedRevision: null,
    commit: null,
    sameCommit: false,
  };
}
function queryText(url: URL, name: string, fallback: string): string {
  const value = url.searchParams.get(name);
  return value === null ? fallback : value.slice(0, 256);
}

function queryRevision(url: URL): number {
  const value = Number(url.searchParams.get('revision') ?? '1');
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export class RuntimeGateAgent
  extends AIChatAgent<Cloudflare.Env, RuntimeGateState>
  implements RuntimeGateRetentionHost
{
  initialState: RuntimeGateState = {};

  private readonly retention: RuntimeGateRetentionSurface;
  private core!: RuntimeGateCore;
  private harnessContext: HarnessContext = runtimeGateDefaultContext();
  private model!: RuntimeGateModel;
  private modelReport!: RuntimeGateModelReport;
  private scenario: RuntimeGateScenario = 'sequence';
  private runNumber = 0;
  private nativeSdkStarted = false;
  private retentionFailure = false;
  private toolExecutions: RuntimeGateToolExecution[] = [];
  private stepReport!: RuntimeGateStepReport;
  private sseEvents: RuntimeGateSseEvent[] = [];
  private replayReport: RuntimeGateReplayReport = emptyReplayReport();
  constructor(ctx: AgentContext, env: Cloudflare.Env) {
    super(ctx, env);
    this.retention = new RuntimeGateRetentionSurface(this, ctx);
    this.initialize('sequence');
  }
  protected sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    return this.retention.sanitize(message);
  }

  configureRuntimeScenario(scenario: RuntimeGateScenario): void {
    this.initialize(scenario);
  }

  configureRetentionFailure(): void {
    this.retentionFailure = true;
  }

  clearRetentionFailure(): void {
    this.retentionFailure = false;
  }

  private initialize(scenario: RuntimeGateScenario): void {
    this.scenario = scenario;
    this.core = new RuntimeGateCore();
    this.modelReport = { calls: 0, requests: [] };
    this.stepReport = {
      bufferedSteps: 0,
      acceptedSteps: [],
      rejectedSteps: [],
      providerOptionsSeen: [],
    };
    const rawModel = modelFor(scenario, this.modelReport);
    this.model = wrapRuntimeGateStepBuffer(rawModel, this.stepReport, {
      maxMs: scenario === 'timeout' ? 50 : 2_000,
    });
    this.toolExecutions = [];
    this.sseEvents = [];
    this.nativeSdkStarted = false;
    this.retentionFailure = false;
    this.replayReport = emptyReplayReport('run');
    this.runNumber += 1;
  }

  private recordTool(
    name: RuntimeGateToolName,
    input: RuntimeGateToolInput,
    options: ToolExecutionOptions,
  ): string {
    const callId = `runtime-gate-call-${this.toolExecutions.length + 1}`;
    this.toolExecutions.push({
      name,
      input,
      abortSignalPassed: options.abortSignal !== undefined,
    });
    return callId;
  }

  private getTools() {
    return {
      search_places: tool<RuntimeGateSearchEnvelope, Result<SearchPlacesOutput>>({
        description: 'Search fixture places.',
        inputSchema: searchPlacesEnvelopeSchema,
        execute: async (envelope, options) => {
          const callId = this.recordTool('search_places', envelope.input, options);
          if (this.scenario === 'structured-error') {
            throw new Error(DENIED_MARKER);
          }
          if (this.scenario === 'cancel') {
            await this.waitForCancellation(options.abortSignal);
          }
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

  private async waitForCancellation(signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    if (signal.aborted) throw new Error('M04_CANCELLED');
  }

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response> {
    this.nativeSdkStarted = true;
    if (this.retentionFailure) throw new Error('M04_RETENTION_PROVIDER_FAILURE');
    const tools = this.getTools();
    const stopAfterCommit: StopCondition<typeof tools> = () => this.core.report.commits.length > 0;
    const stopAfterRepairLimit: StopCondition<typeof tools> = () =>
      this.core.report.repairCount >= 3;
    const result = streamText({
      model: this.model,
      messages: await convertToModelMessages(this.messages),
      tools,
      stopWhen: [stopAfterCommit, stopAfterRepairLimit, stepCountIs(6)],
      maxRetries: 0,
      providerOptions: {
        m04: {
          turnConstraints: TURN_CONSTRAINTS,
          requireEnvelope: true,
        },
      },
      ...(options?.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    });
    const response = result.toUIMessageStreamResponse();
    return sanitizeSseResponse(response, {
      namespace: `turn-${this.runNumber}`,
      onEvent: (event) => this.sseEvents.push(event),
      ...(options?.abortSignal === undefined ? {} : { signal: options.abortSignal }),
    });
  }

  onError(_connectionOrError: unknown, _error?: unknown): void {}

  private publicReport(result: SaveMessagesResult | undefined): RuntimeGatePublicReport {
    return {
      scenario: this.scenario,
      result: saveResult(result),
      nativeSdkStarted: this.nativeSdkStarted,
      replay: this.replayReport,
      toolAllowlist: [...TOOL_ALLOWLIST],
      toolExecutions: this.toolExecutions,
      model: this.modelReport,
      core: this.core.report,
      step: this.stepReport,
      sse: {
        events: this.sseEvents,
        persistedMarkerPresent: JSON.stringify(this.messages).includes(DENIED_MARKER),
      },
    };
  }

  private async storeReplayRecord(
    result: SaveMessagesResult | undefined,
    idempotencyKey: string,
    payload: string,
    turnId: string,
    revision: number,
  ): Promise<void> {
    const commit = this.core.report.commits.at(-1);
    if (result?.status !== 'completed' || commit === undefined) return;
    const record: RuntimeGateReplayRecord = {
      idempotencyKey,
      payloadDigest: await sha256Hex(payload),
      turnId,
      revision,
      commit: {
        responseId: `response-runtime-gate-${this.core.report.commits.length}`,
        revision,
        candidateIds: [...commit.candidateIds],
        evidenceIds: [...commit.evidenceIds],
      },
    };
    this.setState({ replay: record });
    this.replayReport = {
      action: 'run',
      outcome: 'stored',
      idempotencyKey,
      turnId,
      requestedRevision: revision,
      storedRevision: revision,
      commit: record.commit,
      sameCommit: false,
    };
  }

  private async replayResponse(
    url: URL,
    record: RuntimeGateReplayRecord | undefined,
  ): Promise<Response> {
    const idempotencyKey = queryText(url, 'idempotencyKey', 'runtime-gate-key');
    const turnId = queryText(url, 'turnId', 'turn-runtime-gate');
    const requestedRevision = queryRevision(url);
    const payload = queryText(url, 'content', 'same payload');
    const digest = await sha256Hex(payload);
    const commit = record?.commit ?? null;
    let outcome: RuntimeGateReplayReport['outcome'] = 'missing';
    let status: SaveMessagesResult['status'] = 'error';
    let error: string | null = 'IDEMPOTENCY_MISSING';
    let sameCommit = false;

    if (record !== undefined) {
      if (turnId !== record.turnId || idempotencyKey !== record.idempotencyKey) {
        outcome = 'missing';
      } else if (requestedRevision < record.revision) {
        outcome = 'stale';
        error = 'STALE_TURN';
        sameCommit = true;
      } else if (requestedRevision === record.revision && digest === record.payloadDigest) {
        outcome = 'replayed';
        status = 'completed';
        error = null;
        sameCommit = true;
      } else {
        outcome = 'conflict';
        error = 'IDEMPOTENCY_CONFLICT';
      }
    }

    this.nativeSdkStarted = false;
    this.modelReport = { calls: 0, requests: [] };
    this.toolExecutions = [];
    this.stepReport = {
      bufferedSteps: 0,
      acceptedSteps: [],
      rejectedSteps: [],
      providerOptionsSeen: [],
    };
    this.sseEvents = [];
    this.replayReport = {
      action: 'replay',
      outcome,
      idempotencyKey,
      turnId,
      requestedRevision,
      storedRevision: record?.revision ?? null,
      commit,
      sameCommit,
    };

    return Response.json(
      this.publicReport({
        requestId: `runtime-gate-replay-${this.runNumber}`,
        status,
        ...(error === null ? {} : { error }),
      }),
    );
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const retentionResponse = await this.retention.handle(request);
    if (retentionResponse !== undefined) return retentionResponse;
    if (url.pathname === '/replay' && request.method === 'GET') {
      return this.replayResponse(url, this.state.replay);
    }
    if (url.pathname !== '/run' || request.method !== 'GET') {
      return new Response('Not Found', { status: 404 });
    }

    this.initialize(normalizeScenario(url.searchParams.get('case')));
    const idempotencyKey = queryText(url, 'idempotencyKey', 'runtime-gate-key');
    const payload = queryText(url, 'content', 'same payload');
    const turnId = queryText(url, 'turnId', 'turn-runtime-gate');
    const revision = queryRevision(url);
    this.harnessContext = runtimeGateHarnessContext({
      threadId: queryText(url, 'threadId', 'thread-runtime-gate'),
      turnId,
      revision: Math.max(1, revision),
    });
    let result: SaveMessagesResult | undefined;
    const abortController = this.scenario === 'cancel' ? new AbortController() : undefined;
    const cancelTimer =
      abortController === undefined
        ? undefined
        : setTimeout(() => abortController.abort('M04_CANCEL'), 10);
    try {
      result = await this.saveMessages(
        [
          {
            id: `runtime-gate-user-${this.runNumber}`,
            role: 'user',
            parts: [{ type: 'text', text: payload }],
          } satisfies ChatMessage,
        ],
        abortController === undefined ? undefined : { signal: abortController.signal },
      );
    } catch (error) {
      result = {
        requestId: `runtime-gate-${this.runNumber}`,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);
    }
    await this.storeReplayRecord(result, idempotencyKey, payload, turnId, revision);
    return Response.json(this.publicReport(result));
  }
}
