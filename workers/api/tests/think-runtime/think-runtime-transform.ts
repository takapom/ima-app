import type { LanguageModelUsage, StreamTextTransform, TextStreamPart, ToolSet } from 'ai';
import { DENIED_MARKER } from '../support/runtime-model-fixture';

export type ThinkRuntimeTransformReport = {
  inputParts: number;
  markerPartsBefore: number;
  markerPartsAfter: number;
  redactedTextParts: number;
  redactedReasoningParts: number;
  redactedToolInputParts: number;
  redactedToolCallParts: number;
  redactedToolResultParts: number;
  redactedToolErrorParts: number;
  rejectedPartTypes: string[];
};

export type ThinkRuntimeToolCallObserver = (
  toolCallId: string,
  toolName: string,
  input: unknown,
) => void;

export type ThinkRuntimeToolResultObserver = (
  toolCallId: string,
  toolName: string,
  input: unknown,
  output: unknown,
) => void;

type RuntimeTextPart = TextStreamPart<ToolSet>;
type ToolCallPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
  dynamic?: boolean | undefined;
  invalid?: boolean | undefined;
};
type ToolResultPart = Extract<RuntimeTextPart, { type: 'tool-result' }>;
type ToolErrorPart = Extract<RuntimeTextPart, { type: 'tool-error' }>;

type SafeIdState = {
  namespace: string;
  ids: Map<string, string>;
};

function containsMarker(value: unknown): boolean {
  try {
    return JSON.stringify(value).includes(DENIED_MARKER);
  } catch {
    return false;
  }
}

function safeError(): string {
  return 'UPSTREAM_UNAVAILABLE';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeUsage(usage: LanguageModelUsage): LanguageModelUsage {
  return {
    inputTokens: finiteNumber(usage.inputTokens),
    inputTokenDetails: {
      noCacheTokens: finiteNumber(usage.inputTokenDetails.noCacheTokens),
      cacheReadTokens: finiteNumber(usage.inputTokenDetails.cacheReadTokens),
      cacheWriteTokens: finiteNumber(usage.inputTokenDetails.cacheWriteTokens),
    },
    outputTokens: finiteNumber(usage.outputTokens),
    outputTokenDetails: {
      textTokens: finiteNumber(usage.outputTokenDetails.textTokens),
      reasoningTokens: finiteNumber(usage.outputTokenDetails.reasoningTokens),
    },
    totalTokens: finiteNumber(usage.totalTokens),
    reasoningTokens: finiteNumber(usage.reasoningTokens),
    cachedInputTokens: finiteNumber(usage.cachedInputTokens),
  };
}

function safeId(raw: string, prefix: string, state: SafeIdState): string {
  const key = `${prefix}:${raw}`;
  const existing = state.ids.get(key);
  if (existing !== undefined) return existing;
  const id = `${state.namespace}-${prefix}-${state.ids.size + 1}`;
  state.ids.set(key, id);
  return id;
}

/**
 * The transform does not pass model/provider tool arguments into persistence.
 * These schema-shaped placeholders allow the AI SDK parser to reach the
 * public beforeToolCall hook, where the current-turn ephemeral map restores
 * the typed input for execution. The placeholder is never sent to Core.
 */
function safeToolInput(toolName: string): Record<string, unknown> {
  const metadata = {};
  if (toolName === 'search_places') {
    return {
      input: {
        mode: 'search',
        query: 'WITHHELD',
        area: { kind: 'named_area', name: 'WITHHELD' },
        openNow: false,
        limit: 1,
        excludeCandidateIds: [],
      },
      metadata,
    };
  }
  if (toolName === 'get_place_details') {
    return {
      input: {
        requests: [{ candidateId: 'candidate-1', fields: ['identity'] }],
        freshness: 'reuse_valid',
      },
      metadata,
    };
  }
  if (toolName === 'submit_cards') {
    return {
      input: {
        message: [{ text: 'WITHHELD', evidenceIds: [], basis: 'inference' }],
        hero: {
          candidateId: 'candidate-1',
          evidenceIds: [],
          why: { text: 'WITHHELD', evidenceIds: [], basis: 'inference' },
        },
        alts: [],
      },
      metadata,
    };
  }
  return { input: {}, metadata };
}

function safeToolCall(part: ToolCallPart, ids: SafeIdState): ToolCallPart {
  return {
    type: 'tool-call',
    toolCallId: safeId(part.toolCallId, 'tool', ids),
    toolName: part.toolName,
    input: safeToolInput(part.toolName),
    ...(part.dynamic === undefined ? {} : { dynamic: part.dynamic }),
    ...(part.invalid === undefined ? {} : { invalid: part.invalid }),
  };
}

function safeToolResult(part: ToolResultPart, ids: SafeIdState): ToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: safeId(part.toolCallId, 'tool', ids),
    toolName: part.toolName,
    input: safeToolInput(part.toolName),
    output: { type: 'json', value: { status: 'withheld' } },
    ...(part.dynamic === undefined ? {} : { dynamic: part.dynamic }),
    ...(part.preliminary === undefined ? {} : { preliminary: part.preliminary }),
  };
}

function safeToolError(part: ToolErrorPart, ids: SafeIdState): ToolErrorPart {
  return {
    type: 'tool-error',
    toolCallId: safeId(part.toolCallId, 'tool', ids),
    toolName: part.toolName,
    input: safeToolInput(part.toolName),
    error: safeError(),
    ...(part.dynamic === undefined ? {} : { dynamic: part.dynamic }),
  };
}

function rejectPart(report: ThinkRuntimeTransformReport, type: string): never {
  report.rejectedPartTypes.push(type);
  throw new Error(`M04_TRANSFORM_DENY_${type.toUpperCase().replaceAll('-', '_')}`);
}

function rewritePart(
  part: RuntimeTextPart,
  report: ThinkRuntimeTransformReport,
  ids: SafeIdState,
  onToolCall: ThinkRuntimeToolCallObserver | undefined,
  onToolResult: ThinkRuntimeToolResultObserver | undefined,
): RuntimeTextPart {
  report.inputParts += 1;
  if (containsMarker(part)) report.markerPartsBefore += 1;

  let rewritten: RuntimeTextPart;
  switch (part.type) {
    case 'start':
      rewritten = { type: 'start' };
      break;
    case 'text-start':
      rewritten = { type: 'text-start', id: safeId(part.id, 'text', ids) };
      break;
    case 'text-delta':
      report.redactedTextParts += 1;
      rewritten = { type: 'text-delta', id: safeId(part.id, 'text', ids), text: '' };
      break;
    case 'text-end':
      rewritten = { type: 'text-end', id: safeId(part.id, 'text', ids) };
      break;
    case 'reasoning-start':
      rewritten = { type: 'reasoning-start', id: safeId(part.id, 'reasoning', ids) };
      break;
    case 'reasoning-delta':
      report.redactedReasoningParts += 1;
      rewritten = {
        type: 'reasoning-delta',
        id: safeId(part.id, 'reasoning', ids),
        text: '',
      };
      break;
    case 'reasoning-end':
      rewritten = { type: 'reasoning-end', id: safeId(part.id, 'reasoning', ids) };
      break;
    case 'tool-input-start':
      report.redactedToolInputParts += containsMarker(part) ? 1 : 0;
      rewritten = {
        type: 'tool-input-start',
        id: safeId(part.id, 'tool', ids),
        toolName: part.toolName,
        ...(part.dynamic === undefined ? {} : { dynamic: part.dynamic }),
      };
      break;
    case 'tool-input-delta':
      report.redactedToolInputParts += 1;
      rewritten = {
        type: 'tool-input-delta',
        id: safeId(part.id, 'tool', ids),
        delta: '',
      };
      break;
    case 'tool-input-end':
      rewritten = { type: 'tool-input-end', id: safeId(part.id, 'tool', ids) };
      break;
    case 'tool-call': {
      const safeCall = safeToolCall(part, ids);
      onToolCall?.(safeCall.toolCallId, part.toolName, part.input);
      report.redactedToolCallParts += 1;
      // AI SDK's generic ToolSet maps static tool inputs to `never` here even
      // though this public transform only needs the runtime JSON shape.
      rewritten = safeCall as RuntimeTextPart;
      break;
    }
    case 'tool-result':
      onToolResult?.(safeId(part.toolCallId, 'tool', ids), part.toolName, part.input, part.output);
      report.redactedToolResultParts += 1;
      rewritten = safeToolResult(part, ids);
      break;
    case 'tool-error':
      report.redactedToolErrorParts += 1;
      rewritten = safeToolError(part, ids);
      break;
    case 'tool-output-denied':
      rewritten = {
        type: 'tool-output-denied',
        toolCallId: safeId(part.toolCallId, 'tool', ids),
        toolName: part.toolName,
        ...(part.dynamic === undefined ? {} : { dynamic: part.dynamic }),
      };
      break;
    case 'tool-approval-request':
      rewritten = {
        type: 'tool-approval-request',
        approvalId: safeId(part.approvalId, 'approval', ids),
        toolCall: safeToolCall(part.toolCall, ids) as typeof part.toolCall,
      };
      break;
    case 'start-step':
      rewritten = { type: 'start-step', request: {}, warnings: [] };
      break;
    case 'finish-step':
      rewritten = {
        type: 'finish-step',
        response: { id: 'withheld', timestamp: new Date(0), modelId: 'withheld' },
        usage: safeUsage(part.usage),
        finishReason: part.finishReason,
        rawFinishReason: undefined,
        providerMetadata: undefined,
      };
      break;
    case 'finish':
      rewritten = {
        type: 'finish',
        finishReason: part.finishReason,
        rawFinishReason: undefined,
        totalUsage: safeUsage(part.totalUsage),
      };
      break;
    case 'abort':
      rewritten = { type: 'abort', reason: 'CANCELLED' };
      break;
    case 'error':
      rewritten = { type: 'error', error: safeError() };
      break;
    case 'source':
    case 'file':
    case 'raw':
      rejectPart(report, part.type);
  }

  if (containsMarker(rewritten)) report.markerPartsAfter += 1;
  return rewritten;
}

/**
 * Structural persistence policy for the Think turn stream.
 *
 * Every supported part is rebuilt from an explicit allowlist. Text and
 * reasoning are blanked, tool inputs/results are withheld from persistence,
 * and provider metadata/raw parts are dropped or rejected. Tool results and
 * marked tool inputs are observed before redaction so beforeStep can project
 * only the current turn's ephemeral facts back into the next model prompt.
 */
export function createThinkRuntimeTransform(
  report: ThinkRuntimeTransformReport,
  onToolResult?: ThinkRuntimeToolResultObserver,
  onToolCall?: ThinkRuntimeToolCallObserver,
): StreamTextTransform<ToolSet> {
  return () => {
    const ids: SafeIdState = {
      namespace: `think-runtime-${crypto.randomUUID()}`,
      ids: new Map(),
    };
    return new TransformStream<RuntimeTextPart, RuntimeTextPart>({
      transform(part, controller) {
        controller.enqueue(rewritePart(part, report, ids, onToolCall, onToolResult));
      },
    });
  };
}
