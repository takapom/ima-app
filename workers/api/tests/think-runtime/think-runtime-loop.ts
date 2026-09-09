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
