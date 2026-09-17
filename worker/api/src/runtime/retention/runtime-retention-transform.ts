import type {
  FinishReason,
  JSONValue,
  LanguageModelUsage,
  StreamTextTransform,
  TextStreamPart,
  TypedToolCall,
  TypedToolError,
  TypedToolOutputDenied,
  TypedToolResult,
  ToolSet,
} from 'ai';
import { APICallError, InvalidToolInputError } from 'ai';
import { isRuntimeModelGuardError } from '@api/runtime/turn-execution/runtime-model-guard';
import * as v from 'valibot';
import { IsoTimestampSchema } from '@ima/core';
import {
  safeToolInputValidationMessage,
  toolInputInvalidFields,
} from '@api/tools/input-validation-error';
import {
  cloneRuntimeJsonValue,
  isRuntimeJsonValue,
  isRuntimeRetentionToolName,
  redactedRuntimeToolInput,
  type RuntimeRetentionToolName,
} from '@api/runtime/retention/runtime-retention';

export type RuntimeRetentionTransformReport = {
  inputParts: number;
  outputParts: number;
  capturedToolCalls: number;
  capturedToolResults: number;
  rejectedPartTypes: string[];
};

export type RuntimeRetentionToolCallCapture = {
  readonly toolCallId: string;
  readonly toolName: RuntimeRetentionToolName;
  readonly input: JSONValue;
};

export type RuntimeRetentionToolResultCapture = {
  readonly toolCallId: string;
  readonly toolName: RuntimeRetentionToolName;
  readonly output: JSONValue;
  readonly localFreshUntil: string;
  readonly localExpiresAt: string;
};

export type RuntimeRetentionToolOutputProjection = {
  readonly output: JSONValue;
  readonly localFreshUntil: string;
  readonly localExpiresAt: string;
};

export type RuntimeRetentionTransformOptions = {
  readonly namespace?: string;
  readonly projectToolInput: (toolName: RuntimeRetentionToolName, input: unknown) => JSONValue;
  readonly projectToolOutput: (
    toolName: RuntimeRetentionToolName,
    output: unknown,
  ) => RuntimeRetentionToolOutputProjection;
  readonly onToolCall?: (capture: RuntimeRetentionToolCallCapture) => void;
  readonly onToolResult?: (capture: RuntimeRetentionToolResultCapture) => void;
  readonly report?: RuntimeRetentionTransformReport;
};

export class RuntimeRetentionTransformError extends Error {
  readonly code:
    'RETENTION_UNKNOWN_TOOL' | 'RETENTION_UNSAFE_PROJECTION' | 'RETENTION_UNSUPPORTED_PART';

  constructor(
    code: 'RETENTION_UNKNOWN_TOOL' | 'RETENTION_UNSAFE_PROJECTION' | 'RETENTION_UNSUPPORTED_PART',
  ) {
    super(`runtime retention transform denied: ${code}`);
    this.name = 'RuntimeRetentionTransformError';
    this.code = code;
  }
}

type RuntimeTextPart<TOOLS extends ToolSet> = TextStreamPart<TOOLS>;
type ToolCallStreamPart<TOOLS extends ToolSet> = TypedToolCall<TOOLS>;
type ToolResultStreamPart<TOOLS extends ToolSet> = TypedToolResult<TOOLS>;
type ToolErrorStreamPart<TOOLS extends ToolSet> = TypedToolError<TOOLS>;
type ToolOutputDeniedStreamPart<TOOLS extends ToolSet> = TypedToolOutputDenied<TOOLS>;

type SafeIdState = {
  readonly namespace: string;
  readonly ids: Map<string, string>;
};

const FINISH_REASONS = new Set<FinishReason>([
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
]);

const UPSTREAM_CODES = new Set([
  'invalid_api_key',
  'insufficient_quota',
  'credit_balance_exhausted',
  'rate_limit_exceeded',
  'model_not_found',
  'invalid_request_error',
  'invalid_value',
  'invalid_function_parameters',
  'unsupported_parameter',
  'string_above_max_length',
]);

/** Keep diagnostic categories before redaction; never log SDK errors, inputs or response bodies. */
function reportFailure(error: unknown, toolName?: RuntimeRetentionToolName): void {
  const apiError = APICallError.isInstance(error) ? error : undefined;
  const guardError = isRuntimeModelGuardError(error) ? error : undefined;
  const fields = toolName === undefined ? undefined : toolInputInvalidFields(error);
  const data = v.safeParse(
    v.object({ error: v.object({ code: v.nullish(v.string()), param: v.nullish(v.string()) }) }),
    apiError?.data,
  );
  const code = data.success ? data.output.error.code : undefined;
  const param = data.success ? data.output.error.param : undefined;
  // AI SDK emits validation errors as strings on the tool-error stream path.
  const invalidToolInput =
    InvalidToolInputError.isInstance(error) ||
    (toolName !== undefined &&
      typeof error === 'string' &&
      error.startsWith(`Invalid input for tool ${toolName}:`));
  try {
    console.warn(
      JSON.stringify({
        event: 'runtime_upstream_failure',
        stage: toolName === undefined ? 'model' : 'tool',
        ...(toolName === undefined ? {} : { tool: toolName }),
        ...(fields === undefined ? {} : { fields }),
        kind:
          guardError?.code === 'MODEL_STREAM_TIMEOUT'
            ? 'timeout'
            : invalidToolInput
              ? 'invalid_tool_input'
              : 'execution_error',
        ...(apiError?.statusCode === undefined ? {} : { status: apiError.statusCode }),
        ...(typeof code === 'string' && UPSTREAM_CODES.has(code) ? { code } : {}),
        ...(guardError === undefined ? {} : { code: guardError.code }),
        ...(typeof param === 'string' &&
        /^(model|reasoning\.effort|input\[\d+\]\.call_id|tools\[\d+\]\.parameters)$/.test(param)
          ? { param: param.replace(/\[\d+\]/g, '[]') }
          : {}),
      }),
    );
  } catch {
    // Logging must not alter the original failure or its persistence redaction.
  }
}

function safeFinishReason(value: FinishReason): FinishReason {
  return FINISH_REASONS.has(value) ? value : 'other';
}

function safeUsage(usage: LanguageModelUsage): LanguageModelUsage {
  const finite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return {
    inputTokens: finite(usage.inputTokens),
    inputTokenDetails: {
      noCacheTokens: finite(usage.inputTokenDetails.noCacheTokens),
      cacheReadTokens: finite(usage.inputTokenDetails.cacheReadTokens),
      cacheWriteTokens: finite(usage.inputTokenDetails.cacheWriteTokens),
    },
    outputTokens: finite(usage.outputTokens),
    outputTokenDetails: {
      textTokens: finite(usage.outputTokenDetails.textTokens),
      reasoningTokens: finite(usage.outputTokenDetails.reasoningTokens),
    },
    totalTokens: finite(usage.totalTokens),
    reasoningTokens: finite(usage.reasoningTokens),
    cachedInputTokens: finite(usage.cachedInputTokens),
  };
}

function safeId(raw: string, prefix: string, state: SafeIdState): string {
  const existing = state.ids.get(`${prefix}:${raw}`);
  if (existing !== undefined) return existing;
  const next = `${state.namespace}-${prefix}-${state.ids.size + 1}`;
  state.ids.set(`${prefix}:${raw}`, next);
  return next;
}

function safeToolName(raw: string): RuntimeRetentionToolName {
  if (!isRuntimeRetentionToolName(raw)) {
    throw new RuntimeRetentionTransformError('RETENTION_UNKNOWN_TOOL');
  }
  return raw;
}

function projectedJson(
  projector: (toolName: RuntimeRetentionToolName, value: unknown) => JSONValue,
  toolName: RuntimeRetentionToolName,
  value: unknown,
): JSONValue {
  let projected: JSONValue;
  try {
    projected = projector(toolName, value);
  } catch {
    throw new RuntimeRetentionTransformError('RETENTION_UNSAFE_PROJECTION');
  }
  if (!isRuntimeJsonValue(projected)) {
    throw new RuntimeRetentionTransformError('RETENTION_UNSAFE_PROJECTION');
  }
  try {
    return cloneRuntimeJsonValue(projected);
  } catch {
    throw new RuntimeRetentionTransformError('RETENTION_UNSAFE_PROJECTION');
  }
}

function projectedToolOutput(
  projector: RuntimeRetentionTransformOptions['projectToolOutput'],
  toolName: RuntimeRetentionToolName,
  value: unknown,
): RuntimeRetentionToolOutputProjection {
  let projected: RuntimeRetentionToolOutputProjection;
  try {
    projected = projector(toolName, value);
  } catch {
    throw new RuntimeRetentionTransformError('RETENTION_UNSAFE_PROJECTION');
  }
  const freshUntil = v.safeParse(IsoTimestampSchema, projected.localFreshUntil);
  const expiresAt = v.safeParse(IsoTimestampSchema, projected.localExpiresAt);
  if (
    !isRuntimeJsonValue(projected.output) ||
    !freshUntil.success ||
    !expiresAt.success ||
    Date.parse(freshUntil.output) > Date.parse(expiresAt.output)
  ) {
    throw new RuntimeRetentionTransformError('RETENTION_UNSAFE_PROJECTION');
  }
  let output: JSONValue;
  try {
    output = cloneRuntimeJsonValue(projected.output);
  } catch {
    throw new RuntimeRetentionTransformError('RETENTION_UNSAFE_PROJECTION');
  }
  return {
    output,
    localFreshUntil: freshUntil.output,
    localExpiresAt: expiresAt.output,
  };
}

function dynamicFlag(dynamic: boolean | undefined): { dynamic: true } | Record<string, never> {
  return dynamic === true ? { dynamic: true } : {};
}

function safeToolCall<TOOLS extends ToolSet>(
  part: ToolCallStreamPart<TOOLS>,
  state: SafeIdState,
  options: RuntimeRetentionTransformOptions,
  report: RuntimeRetentionTransformReport,
): ToolCallStreamPart<TOOLS> {
  const toolName = safeToolName(part.toolName);
  const toolCallId = safeId(part.toolCallId, 'tool', state);
  const input = projectedJson(options.projectToolInput, toolName, part.input);
  options.onToolCall?.({ toolCallId, toolName, input });
  report.capturedToolCalls += 1;
  /* AI SDK's static tool union binds input to each tool schema; the public transform replaces it with a schema-shaped JSON value. */
  return {
    type: 'tool-call',
    toolCallId,
    toolName: part.toolName,
    input: redactedRuntimeToolInput(toolName),
    ...dynamicFlag(part.dynamic),
  } as ToolCallStreamPart<TOOLS>;
}

function safeToolResult<TOOLS extends ToolSet>(
  part: ToolResultStreamPart<TOOLS>,
  state: SafeIdState,
  options: RuntimeRetentionTransformOptions,
  report: RuntimeRetentionTransformReport,
): ToolResultStreamPart<TOOLS> {
  const toolName = safeToolName(part.toolName);
  const toolCallId = safeId(part.toolCallId, 'tool', state);
  const projection = projectedToolOutput(options.projectToolOutput, toolName, part.output);
  options.onToolResult?.({
    toolCallId,
    toolName,
    output: projection.output,
    localFreshUntil: projection.localFreshUntil,
    localExpiresAt: projection.localExpiresAt,
  });
  report.capturedToolResults += 1;
  /* See the corresponding tool-call cast: only the public AI SDK generic union prevents this safe replacement from being expressed. */
  return {
    type: 'tool-result',
    toolCallId,
    toolName: part.toolName,
    input: redactedRuntimeToolInput(toolName),
    output: { type: 'json', value: { status: 'withheld' } },
    ...dynamicFlag(part.dynamic),
    ...(part.preliminary === true ? { preliminary: true } : {}),
  } as ToolResultStreamPart<TOOLS>;
}

function safeToolError<TOOLS extends ToolSet>(
  part: ToolErrorStreamPart<TOOLS>,
  state: SafeIdState,
): ToolErrorStreamPart<TOOLS> {
  const toolName = safeToolName(part.toolName);
  reportFailure(part.error, toolName);
  return {
    type: 'tool-error',
    toolCallId: safeId(part.toolCallId, 'tool', state),
    toolName: part.toolName,
    input: redactedRuntimeToolInput(toolName),
    error: safeToolInputValidationMessage(part.error) ?? 'UPSTREAM_UNAVAILABLE',
    ...dynamicFlag(part.dynamic),
  } as ToolErrorStreamPart<TOOLS>;
}

function rewritePart<TOOLS extends ToolSet>(
  part: RuntimeTextPart<TOOLS>,
  state: SafeIdState,
  options: RuntimeRetentionTransformOptions,
  report: RuntimeRetentionTransformReport,
): RuntimeTextPart<TOOLS> {
  report.inputParts += 1;
  switch (part.type) {
    case 'start':
      return { type: 'start' };
    case 'text-start':
      return { type: 'text-start', id: safeId(part.id, 'text', state) };
    case 'text-delta':
      return { type: 'text-delta', id: safeId(part.id, 'text', state), text: '' };
    case 'text-end':
      return { type: 'text-end', id: safeId(part.id, 'text', state) };
    case 'reasoning-start':
      return { type: 'reasoning-start', id: safeId(part.id, 'reasoning', state) };
    case 'reasoning-delta':
      return { type: 'reasoning-delta', id: safeId(part.id, 'reasoning', state), text: '' };
    case 'reasoning-end':
      return { type: 'reasoning-end', id: safeId(part.id, 'reasoning', state) };
    case 'tool-input-start': {
      const toolName = safeToolName(part.toolName);
      return {
        type: 'tool-input-start',
        id: safeId(part.id, 'tool', state),
        toolName,
        ...dynamicFlag(part.dynamic),
      };
    }
    case 'tool-input-delta':
      return { type: 'tool-input-delta', id: safeId(part.id, 'tool', state), delta: '' };
    case 'tool-input-end':
      return { type: 'tool-input-end', id: safeId(part.id, 'tool', state) };
    case 'tool-call':
      return safeToolCall(part, state, options, report);
    case 'tool-result':
      return safeToolResult(part, state, options, report);
    case 'tool-error':
      return safeToolError(part, state);
    case 'tool-output-denied': {
      const toolName = safeToolName(part.toolName);
      return {
        type: 'tool-output-denied',
        toolCallId: safeId(part.toolCallId, 'tool', state),
        toolName,
        ...dynamicFlag(part.dynamic),
      } as ToolOutputDeniedStreamPart<TOOLS>;
    }
    case 'tool-approval-request': {
      const toolCall = safeToolCall(part.toolCall, state, options, report);
      return {
        type: 'tool-approval-request',
        approvalId: safeId(part.approvalId, 'approval', state),
        toolCall,
      };
    }
    case 'start-step':
      return { type: 'start-step', request: {}, warnings: [] };
    case 'finish-step':
      return {
        type: 'finish-step',
        response: { id: 'withheld', timestamp: new Date(0), modelId: 'withheld' },
        usage: safeUsage(part.usage),
        finishReason: safeFinishReason(part.finishReason),
        rawFinishReason: undefined,
        providerMetadata: undefined,
      };
    case 'finish':
      return {
        type: 'finish',
        finishReason: safeFinishReason(part.finishReason),
        rawFinishReason: undefined,
        totalUsage: safeUsage(part.totalUsage),
      };
    case 'abort':
      return { type: 'abort', reason: 'CANCELLED' };
    case 'error':
      reportFailure(part.error);
      return { type: 'error', error: 'UPSTREAM_UNAVAILABLE' };
    case 'source':
    case 'file':
    case 'raw':
      report.rejectedPartTypes.push(part.type);
      throw new RuntimeRetentionTransformError('RETENTION_UNSUPPORTED_PART');
  }
}

/** Public AI SDK transform: captures projected ephemeral tool data and structurally rebuilds every persisted stream part. */
export function createRuntimeRetentionTransform<TOOLS extends ToolSet>(
  options: RuntimeRetentionTransformOptions,
): StreamTextTransform<TOOLS> {
  const report = options.report ?? {
    inputParts: 0,
    outputParts: 0,
    capturedToolCalls: 0,
    capturedToolResults: 0,
    rejectedPartTypes: [],
  };
  return ({ tools, stopStream }) => {
    void tools;
    void stopStream;
    const state: SafeIdState = {
      namespace: options.namespace ?? `runtime-retention-${crypto.randomUUID()}`,
      ids: new Map(),
    };
    return new TransformStream<RuntimeTextPart<TOOLS>, RuntimeTextPart<TOOLS>>({
      transform(part, controller) {
        const rewritten = rewritePart(part, state, options, report);
        report.outputParts += 1;
        controller.enqueue(rewritten);
      },
    });
  };
}
