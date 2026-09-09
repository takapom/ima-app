import type { JSONValue, ModelMessage } from 'ai';

export type ThinkRuntimeEphemeralToolResult = {
  toolCallId: string;
  toolName: string;
  output: JSONValue;
};

export type ThinkRuntimeEphemeralToolCall = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

/**
 * Add a caller-owned message to the current model prompt without touching the
 * Session history. The caller clears the value when the turn finishes.
 */
export function projectThinkRuntimeCurrentTurnContent(
  messages: ModelMessage[],
  start: number,
  content: string | null,
): ModelMessage[] {
  if (content === null) return messages;
  const currentTurnStart = Math.max(0, start - 1);
  let userIndex = -1;
  for (let index = messages.length - 1; index >= currentTurnStart; index -= 1) {
    if (messages[index]?.role === 'user') {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return messages;
  const user = messages[userIndex];
  if (user === undefined || user.role !== 'user') return messages;
  const ephemeralPart = { type: 'text' as const, text: content };
  const projectedUser: ModelMessage = {
    ...user,
    content:
      typeof user.content === 'string'
        ? `${user.content}\n${content}`
        : [...user.content, ephemeralPart],
  };
  return [...messages.slice(0, userIndex), projectedUser, ...messages.slice(userIndex + 1)];
}

export function projectThinkRuntimeEphemeralResults(
  messages: ModelMessage[],
  start: number,
  calls: ReadonlyMap<string, ThinkRuntimeEphemeralToolCall>,
  results: ReadonlyMap<string, ThinkRuntimeEphemeralToolResult>,
): { messages: ModelMessage[]; projected: number } {
  let projected = 0;
  const currentTurn = messages.slice(start).map((message) => {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== 'tool-call') return part;
          const call = calls.get(part.toolCallId);
          return call === undefined ? part : { ...part, input: call.input };
        }),
      };
    }
    if (message.role !== 'tool') return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'tool-result') return part;
        const result = results.get(part.toolCallId);
        if (result === undefined) return part;
        projected += 1;
        return { ...part, output: { type: 'json' as const, value: result.output } };
      }),
    };
  });
  return { messages: [...messages.slice(0, start), ...currentTurn], projected };
}

export async function waitForThinkRuntimeCancellation(
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 50);
    signal.addEventListener(
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
