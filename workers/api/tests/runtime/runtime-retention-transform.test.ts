import { jsonSchema } from 'ai';
import type { JSONValue, LanguageModelUsage, TextStreamPart, Tool } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  createRuntimeRetentionTransform,
  type RuntimeRetentionTransformOptions,
  type RuntimeRetentionToolOutputProjection,
  type RuntimeRetentionTransformReport,
} from '../../src/runtime/retention/runtime-retention-transform';

const CANARY = `provider-secret-${crypto.randomUUID()}`;
type TestTools = {
  search_places: Tool<JSONValue, JSONValue>;
  get_place_details: Tool<JSONValue, JSONValue>;
  submit_cards: Tool<JSONValue, JSONValue>;
};
type Part = TextStreamPart<TestTools>;
const TEST_SCHEMA = jsonSchema<JSONValue>({ type: 'object', additionalProperties: true });
const TEST_TOOLS = {
  search_places: { inputSchema: TEST_SCHEMA, outputSchema: TEST_SCHEMA },
  get_place_details: { inputSchema: TEST_SCHEMA, outputSchema: TEST_SCHEMA },
  submit_cards: { inputSchema: TEST_SCHEMA, outputSchema: TEST_SCHEMA },
} satisfies TestTools;

const USAGE: LanguageModelUsage = {
  inputTokens: 5,
  inputTokenDetails: {
    noCacheTokens: 4,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
  },
  outputTokens: 3,
  outputTokenDetails: {
    textTokens: 2,
    reasoningTokens: 1,
  },
  totalTokens: 8,
  reasoningTokens: 1,
  cachedInputTokens: 1,
};

async function runTransform(
  parts: readonly Part[],
  options: RuntimeRetentionTransformOptions,
): Promise<Part[]> {
  const transform = createRuntimeRetentionTransform<TestTools>(options);
  const source = new ReadableStream<Part>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  const output = source.pipeThrough(
    transform({
      tools: TEST_TOOLS,
      stopStream: () => undefined,
    }),
  );
  const reader = output.getReader();
  const values: Part[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) return values;
    values.push(next.value);
  }
}

function inputProjector(
  _toolName: 'search_places' | 'get_place_details' | 'submit_cards',
): JSONValue {
  return { placeRef: 'place-server-1' };
}

function outputProjector(
  _toolName: 'search_places' | 'get_place_details' | 'submit_cards',
): RuntimeRetentionToolOutputProjection {
  return {
    output: { placeName: 'Cafe server' },
    localFreshUntil: '2026-09-10T01:00:00Z',
    localExpiresAt: '2026-09-10T01:30:00Z',
  };
}

describe('runtime retention AI SDK stream transform', () => {
  it('captures projected ephemeral tool data and rebuilds every persisted part', async () => {
    const report: RuntimeRetentionTransformReport = {
      inputParts: 0,
      outputParts: 0,
      capturedToolCalls: 0,
      capturedToolResults: 0,
      rejectedPartTypes: [],
    };
    const capturedCalls: JSONValue[] = [];
    const capturedResults: JSONValue[] = [];
    const textDelta: Part = { type: 'text-delta', id: 'provider-text', text: CANARY };
    Object.defineProperty(textDelta, 'unknownProviderField', {
      enumerable: true,
      value: CANARY,
    });
    const parts: Part[] = [
      { type: 'start' },
      { type: 'text-start', id: 'provider-text' },
      textDelta,
      { type: 'text-end', id: 'provider-text' },
      { type: 'reasoning-delta', id: 'provider-reasoning', text: CANARY },
      { type: 'tool-input-start', id: 'provider-input', toolName: 'search_places' },
      { type: 'tool-input-delta', id: 'provider-input', delta: CANARY },
      { type: 'tool-input-end', id: 'provider-input' },
      {
        type: 'tool-call',
        toolCallId: 'provider-call',
        toolName: 'search_places',
        input: { placeRef: 'place-server-1', secret: CANARY },
        toolMetadata: { secret: CANARY },
      },
      {
        type: 'tool-result',
        toolCallId: 'provider-call',
        toolName: 'search_places',
        input: { secret: CANARY },
        output: { type: 'json', value: { placeName: 'Cafe server', secret: CANARY } },
        preliminary: true,
      },
      {
        type: 'tool-error',
        toolCallId: 'provider-error',
        toolName: 'search_places',
        input: { secret: CANARY },
        error: CANARY,
      },
      { type: 'start-step', request: {}, warnings: [] },
      {
        type: 'finish-step',
        response: { id: CANARY, timestamp: new Date(), modelId: CANARY },
        usage: USAGE,
        finishReason: 'stop',
        rawFinishReason: CANARY,
        providerMetadata: undefined,
      },
      { type: 'finish', finishReason: 'stop', rawFinishReason: CANARY, totalUsage: USAGE },
    ];

    const output = await runTransform(parts, {
      namespace: 'retention-test',
      projectToolInput: (_toolName, _input) => inputProjector('search_places'),
      projectToolOutput: (_toolName, _output) => outputProjector('search_places'),
      onToolCall: (capture) => capturedCalls.push(capture.input),
      onToolResult: (capture) => capturedResults.push(capture.output),
      report,
    });

    expect(report).toMatchObject({
      inputParts: parts.length,
      outputParts: parts.length,
      capturedToolCalls: 1,
      capturedToolResults: 1,
      rejectedPartTypes: [],
    });
    expect(capturedCalls).toEqual([{ placeRef: 'place-server-1' }]);
    expect(capturedResults).toEqual([{ placeName: 'Cafe server' }]);
    expect(JSON.stringify(output)).not.toContain(CANARY);
    expect(output).toContainEqual({ type: 'text-delta', id: 'retention-test-text-1', text: '' });
    expect(output).toContainEqual({
      type: 'tool-call',
      toolCallId: 'retention-test-tool-4',
      toolName: 'search_places',
      input: {
        input: {
          mode: 'search',
          query: 'WITHHELD',
          area: { kind: 'named_area', name: 'WITHHELD' },
          openNow: false,
          limit: 1,
          excludeCandidateIds: [],
        },
        metadata: {},
      },
    });
    expect(output).toContainEqual({
      type: 'tool-result',
      toolCallId: 'retention-test-tool-4',
      toolName: 'search_places',
      input: {
        input: {
          mode: 'search',
          query: 'WITHHELD',
          area: { kind: 'named_area', name: 'WITHHELD' },
          openNow: false,
          limit: 1,
          excludeCandidateIds: [],
        },
        metadata: {},
      },
      output: { type: 'json', value: { status: 'withheld' } },
      preliminary: true,
    });
    expect(output).toContainEqual({
      type: 'tool-error',
      toolCallId: 'retention-test-tool-5',
      toolName: 'search_places',
      input: {
        input: {
          mode: 'search',
          query: 'WITHHELD',
          area: { kind: 'named_area', name: 'WITHHELD' },
          openNow: false,
          limit: 1,
          excludeCandidateIds: [],
        },
        metadata: {},
      },
      error: 'UPSTREAM_UNAVAILABLE',
    });
    expect(output).toContainEqual({
      type: 'finish-step',
      response: { id: 'withheld', timestamp: new Date(0), modelId: 'withheld' },
      usage: USAGE,
      finishReason: 'stop',
      rawFinishReason: undefined,
      providerMetadata: undefined,
    });
  });

  it('rejects unknown or unsupported parts before downstream persistence can observe them', async () => {
    const unknownTool: Part = {
      type: 'tool-input-start',
      id: 'provider-input',
      toolName: 'unknown_tool',
    };
    await expect(
      runTransform([unknownTool], {
        namespace: 'unknown-test',
        projectToolInput: inputProjector,
        projectToolOutput: outputProjector,
      }),
    ).rejects.toMatchObject({
      code: 'RETENTION_UNKNOWN_TOOL',
    });

    const unsupported: Part = { type: 'raw', rawValue: CANARY };
    await expect(
      runTransform([unsupported], {
        namespace: 'unsupported-test',
        projectToolInput: inputProjector,
        projectToolOutput: outputProjector,
      }),
    ).rejects.toMatchObject({
      code: 'RETENTION_UNSUPPORTED_PART',
    });
  });

  it('fails closed when a projection returns non-plain JSON and emits stable abort/error parts', async () => {
    const badProjection = (): JSONValue => {
      const value: { safe: string } = { safe: 'value' };
      Object.defineProperty(value, 'secret', {
        enumerable: true,
        get: () => CANARY,
      });
      return value;
    };
    await expect(
      runTransform(
        [
          {
            type: 'tool-call',
            toolCallId: 'provider-call',
            toolName: 'search_places',
            input: { secret: CANARY },
          },
        ],
        {
          namespace: 'unsafe-test',
          projectToolInput: badProjection,
          projectToolOutput: outputProjector,
        },
      ),
    ).rejects.toMatchObject({
      code: 'RETENTION_UNSAFE_PROJECTION',
    });

    const output = await runTransform(
      [
        { type: 'abort', reason: CANARY },
        { type: 'error', error: CANARY },
      ],
      {
        namespace: 'terminal-test',
        projectToolInput: inputProjector,
        projectToolOutput: outputProjector,
      },
    );
    expect(output).toEqual([
      { type: 'abort', reason: 'CANCELLED' },
      { type: 'error', error: 'UPSTREAM_UNAVAILABLE' },
    ]);
  });
});
