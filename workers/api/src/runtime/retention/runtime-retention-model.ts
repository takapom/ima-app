import type {
  AssistantContent,
  AssistantModelMessage,
  JSONValue,
  ModelMessage,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCallPart,
  ToolContent,
  ToolResultPart,
  UserContent,
} from 'ai';
import {
  cloneRuntimeJsonValue,
  isRuntimeRetentionToolName,
  redactedRuntimeToolInput,
  runtimeEphemeralIsUsable,
  RUNTIME_RETENTION_WITHHELD,
  type RuntimeRetentionEphemeralToolCall,
  type RuntimeRetentionEphemeralToolResult,
  type RuntimeRetentionScopeIdentity,
} from '../runtime-retention';
import { runtimeEphemeralModelInputIsUsable } from './runtime-retention-model-window';

export type RuntimeRetentionModelProjectionOptions = {
  readonly currentTurnStart: number;
  readonly currentScope: RuntimeRetentionScopeIdentity;
  readonly now: string;
  readonly trustedSystemText?: string;
  readonly toolCalls: ReadonlyMap<string, RuntimeRetentionEphemeralToolCall>;
  readonly toolResults: ReadonlyMap<string, RuntimeRetentionEphemeralToolResult>;
  /** Applies the independently evaluated `llm_input` policy to provider tool results. */
  readonly projectToolOutput?: (output: JSONValue) => JSONValue;
};

type AssistantParts = Exclude<AssistantContent, string>;
type UserParts = Exclude<UserContent, string>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cloneJson = (value: JSONValue): JSONValue => cloneRuntimeJsonValue(value);

const withheldToolOutput = (): ToolResultPart['output'] => ({
  type: 'json',
  value: { status: 'withheld' },
});

const safeToolInput = (toolName: string): JSONValue =>
  isRuntimeRetentionToolName(toolName)
    ? redactedRuntimeToolInput(toolName)
    : { status: 'withheld' };

function usableToolInput(
  toolCallId: string,
  toolName: string,
  options: RuntimeRetentionModelProjectionOptions,
  currentTurn: boolean,
): JSONValue {
  if (!currentTurn) return safeToolInput(toolName);
  const entry = options.toolCalls.get(toolCallId);
  return entry !== undefined &&
    entry.toolName === toolName &&
    runtimeEphemeralIsUsable(entry, options.currentScope, options.now)
    ? cloneJson(entry.input)
    : safeToolInput(toolName);
}

function usableToolOutput(
  toolCallId: string,
  toolName: string,
  options: RuntimeRetentionModelProjectionOptions,
  currentTurn: boolean,
): ToolResultPart['output'] {
  if (!currentTurn) return withheldToolOutput();
  const entry = options.toolResults.get(toolCallId);
  const usable =
    options.projectToolOutput === undefined
      ? runtimeEphemeralIsUsable
      : runtimeEphemeralModelInputIsUsable;
  if (
    entry === undefined ||
    entry.toolName !== toolName ||
    !usable(entry, options.currentScope, options.now)
  ) {
    return withheldToolOutput();
  }
  try {
    const output = options.projectToolOutput?.(entry.output) ?? entry.output;
    return { type: 'json', value: cloneJson(output) };
  } catch {
    return withheldToolOutput();
  }
}

function normalizeToolCall(
  part: ToolCallPart,
  options: RuntimeRetentionModelProjectionOptions,
  currentTurn: boolean,
): ToolCallPart | undefined {
  if (!isRuntimeRetentionToolName(part.toolName)) return undefined;
  return {
    type: 'tool-call',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: usableToolInput(part.toolCallId, part.toolName, options, currentTurn),
  };
}

function normalizeToolResult(
  part: ToolResultPart,
  options: RuntimeRetentionModelProjectionOptions,
  currentTurn: boolean,
): ToolResultPart | undefined {
  if (!isRuntimeRetentionToolName(part.toolName)) return undefined;
  return {
    type: 'tool-result',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: usableToolOutput(part.toolCallId, part.toolName, options, currentTurn),
  };
}

function normalizeApprovalRequest(part: ToolApprovalRequest): ToolApprovalRequest | undefined {
  return {
    type: 'tool-approval-request',
    approvalId: part.approvalId,
    toolCallId: part.toolCallId,
  };
}

function normalizeAssistant(
  message: Extract<ModelMessage, { role: 'assistant' }>,
  options: RuntimeRetentionModelProjectionOptions,
  currentTurn: boolean,
): AssistantModelMessage {
  if (typeof message.content === 'string') {
    return { role: 'assistant', content: RUNTIME_RETENTION_WITHHELD };
  }
  const content: AssistantParts = [];
  for (const part of message.content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      content.push({ type: 'text', text: RUNTIME_RETENTION_WITHHELD });
      continue;
    }
    if (part.type === 'reasoning' && typeof part.text === 'string') {
      content.push({ type: 'reasoning', text: RUNTIME_RETENTION_WITHHELD });
      continue;
    }
    if (part.type === 'tool-call') {
      const normalized = normalizeToolCall(part, options, currentTurn);
      if (normalized !== undefined) content.push(normalized);
      continue;
    }
    if (part.type === 'tool-result') {
      const normalized = normalizeToolResult(part, options, currentTurn);
      if (normalized !== undefined) content.push(normalized);
      continue;
    }
    if (part.type === 'tool-approval-request') {
      const normalized = normalizeApprovalRequest(part);
      if (normalized !== undefined) content.push(normalized);
    }
  }
  return {
    role: 'assistant',
    content: content.length === 0 ? [{ type: 'text', text: RUNTIME_RETENTION_WITHHELD }] : content,
  };
}

function normalizeUser(message: Extract<ModelMessage, { role: 'user' }>): ModelMessage {
  if (typeof message.content === 'string') {
    return {
      role: 'user',
      content: RUNTIME_RETENTION_WITHHELD,
    };
  }
  const content: UserParts = [];
  for (const part of message.content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      content.push({ type: 'text', text: RUNTIME_RETENTION_WITHHELD });
    }
  }
  return {
    role: 'user',
    content: content.length === 0 ? [{ type: 'text', text: RUNTIME_RETENTION_WITHHELD }] : content,
  };
}

function normalizeTool(
  message: Extract<ModelMessage, { role: 'tool' }>,
  options: RuntimeRetentionModelProjectionOptions,
  currentTurn: boolean,
): ModelMessage {
  const content: ToolContent = [];
  for (const part of message.content) {
    if (part.type === 'tool-result') {
      const normalized = normalizeToolResult(part, options, currentTurn);
      if (normalized !== undefined) content.push(normalized);
      continue;
    }
    if (part.type === 'tool-approval-response') {
      const approval: ToolApprovalResponse = {
        type: 'tool-approval-response',
        approvalId: part.approvalId,
        approved: part.approved,
      };
      content.push(approval);
    }
  }
  return { role: 'tool', content };
}

function normalizeMessage(
  message: ModelMessage,
  currentTurn: boolean,
  options: RuntimeRetentionModelProjectionOptions,
): ModelMessage {
  switch (message.role) {
    case 'system':
      return {
        role: 'system',
        content:
          typeof message.content === 'string' && message.content === options.trustedSystemText
            ? message.content
            : RUNTIME_RETENTION_WITHHELD,
      };
    case 'user':
      return normalizeUser(message);
    case 'assistant':
      return normalizeAssistant(message, options, currentTurn);
    case 'tool':
      return normalizeTool(message, options, currentTurn);
  }
}

/**
 * Rebuilds AI SDK ModelMessage values and restores only current-turn ephemeral tool data.
 * SDK user/assistant text, including the current user message, is withheld because ModelMessage
 * has no retention metadata. M08 supplies approved current-turn context separately after its
 * own projection and sanitization. Provider options, files, sources, custom parts, and unknown
 * fields never pass through.
 */
export function projectRuntimeCurrentTurnMessages(
  messages: readonly ModelMessage[],
  options: RuntimeRetentionModelProjectionOptions,
): ModelMessage[] {
  const start = Math.max(0, Math.min(options.currentTurnStart, messages.length));
  return messages.map((message, index) => normalizeMessage(message, index >= start, options));
}
