import { describe, expect, it } from 'vitest';
import { MODEL_SYSTEM_PROMPT } from '@worker/runtime/model/system-prompt';
import type {
  RuntimeModelGuardCallOptions,
  RuntimeModelGuardGenerateResult,
  RuntimeModelGuardModel,
  RuntimeModelGuardStreamPart,
} from '@worker/runtime/turn-execution/runtime-model-guard';
import { createEvalModelRecorder } from '../../tooling/eval/model-recorder';
import { EvalVariantNotAppliedError } from '../../tooling/eval/variants';

type FinishPart = Extract<RuntimeModelGuardStreamPart, { type: 'finish' }>;
type Prompt = RuntimeModelGuardCallOptions['prompt'];

const finish: FinishPart = {
  type: 'finish',
  usage: {
    inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 30, text: 30, reasoning: 0 },
  },
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
};

const toolCall = (id: string, name: string, input: string): RuntimeModelGuardStreamPart => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: name,
  input,
});

const streamOf = (parts: readonly RuntimeModelGuardStreamPart[]) =>
  new ReadableStream<RuntimeModelGuardStreamPart>({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });

const drain = async (stream: ReadableStream<RuntimeModelGuardStreamPart>) => {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // 最後まで読むと、記録側がfinishを受け取れる。
  }
};

/** 台本どおりにstepを返し、受け取ったpromptを保持するモデル。 */
const scriptedModel = (steps: RuntimeModelGuardStreamPart[][]) => {
  const prompts: Prompt[] = [];
  const model: RuntimeModelGuardModel = {
    specificationVersion: 'v3',
    provider: 'eval-recorder-test',
    modelId: 'scripted',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('generate is not scripted')),
    doStream: (options) => {
      prompts.push(options.prompt);
      return Promise.resolve({ stream: streamOf(steps.shift() ?? [finish]) });
    },
  };
  return { model, prompts };
};

const basePrompt: Prompt = [
  { role: 'system', content: MODEL_SYSTEM_PROMPT },
  { role: 'user', content: [{ type: 'text', text: '{"kind":"ima_turn_context"}' }] },
];

type ToolMessage = Extract<Prompt[number], { role: 'tool' }>;
type ToolOutput = Extract<ToolMessage['content'][number], { type: 'tool-result' }>['output'];

const json = (value: Extract<ToolOutput, { type: 'json' }>['value']): ToolOutput => ({
  type: 'json',
  value,
});
const errorText = (value: string): ToolOutput => ({ type: 'error-text', value });

/** 実行時と同じく、promptの中のtoolCallIdはモデルが出したIDから書き換えられている。 */
const withToolResults = (results: readonly { name: string; output: ToolOutput }[]): Prompt => [
  ...basePrompt,
  {
    role: 'assistant',
    content: results.map(({ name }, index) => ({
      type: 'tool-call' as const,
      toolCallId: `rewritten-${index}`,
      toolName: name,
      input: {},
    })),
  },
  {
    role: 'tool',
    content: results.map(({ name, output }, index) => ({
      type: 'tool-result' as const,
      toolCallId: `rewritten-${index}`,
      toolName: name,
      output,
    })),
  },
];

const failedResults = withToolResults([
  {
    name: 'search_places',
    output: json({ status: 'error', error: { code: 'LOCATION_REQUIRED' } }),
  },
  {
    name: 'respond',
    output: json({ status: 'invalid', issues: [{ code: 'MISSING_EVIDENCE' }] }),
  },
  {
    name: 'search_places',
    output: errorText('Tool input validation failed. Invalid fields: input.area'),
  },
]);

describe('createEvalModelRecorder', () => {
  it('records tool calls with their arguments and the result the model saw next', async () => {
    const { model } = scriptedModel([
      [toolCall('call-1', 'search_places', '{"input":{"query":"スイーツ"}}'), finish],
      [toolCall('call-2', 'respond', '{"input":{"kind":"propose"}}'), finish],
    ]);
    const clock = [0, 40, 100, 160];
    const recorder = createEvalModelRecorder(() => clock.shift() ?? 0);
    const wrapped = recorder.wrap(model);

    await drain((await wrapped.doStream({ prompt: basePrompt })).stream);
    await drain(
      (
        await wrapped.doStream({
          prompt: withToolResults([
            {
              name: 'search_places',
              output: json({ status: 'ok', data: { candidates: [{}, {}, {}] }, warnings: [] }),
            },
          ]),
        })
      ).stream,
    );

    const turn = recorder.takeTurn();
    expect(turn.toolCalls).toEqual([
      {
        name: 'search_places',
        args: { input: { query: 'スイーツ' } },
        result: { status: 'ok', code: null, candidates: 3, issues: [] },
      },
      { name: 'respond', args: { input: { kind: 'propose' } }, result: null },
    ]);
    expect(turn.modelCalls).toEqual([
      { ms: 40, inputTokens: 120, outputTokens: 30, toolNames: ['search_places'], failure: null },
      { ms: 60, inputTokens: 120, outputTokens: 30, toolNames: ['respond'], failure: null },
    ]);
    expect(turn.toolResultsMatched).toBe(true);
    expect(turn.respondMissing).toEqual([]);
    // 次のターンは空から始まる。
    expect(recorder.takeTurn().toolCalls).toEqual([]);
  });

  it('attaches no result when the prompt calls do not match the recorded calls', async () => {
    // promptには記録にない呼び出しが並んでいる。順序と名前で無理に結ぶと別の呼び出しの結果が付く。
    const { model } = scriptedModel([[toolCall('call-4', 'respond', '{}'), finish]]);
    const recorder = createEvalModelRecorder();
    await drain((await recorder.wrap(model).doStream({ prompt: failedResults })).stream);
    const turn = recorder.takeTurn();
    expect(turn.toolCalls).toEqual([{ name: 'respond', args: {}, result: null }]);
    expect(turn.toolResultsMatched).toBe(false);
  });

  it('maps every tool result type to a summary', async () => {
    const { model } = scriptedModel([
      [toolCall('call-1', 'search_places', '{}'), finish],
      [toolCall('call-2', 'respond', '{}'), finish],
      [toolCall('call-3', 'search_places', '{}'), finish],
      [finish],
    ]);
    const recorder = createEvalModelRecorder();
    const wrapped = recorder.wrap(model);
    await drain((await wrapped.doStream({ prompt: basePrompt })).stream);
    await drain((await wrapped.doStream({ prompt: basePrompt })).stream);
    await drain((await wrapped.doStream({ prompt: basePrompt })).stream);
    await drain((await wrapped.doStream({ prompt: failedResults })).stream);
    const turn = recorder.takeTurn();
    expect(turn.toolCalls.map((call) => call.result)).toEqual([
      { status: 'error', code: 'LOCATION_REQUIRED', candidates: null, issues: [] },
      { status: 'invalid', code: null, candidates: null, issues: ['MISSING_EVIDENCE'] },
      { status: 'tool_error', code: null, candidates: null, issues: ['input.area'] },
    ]);
    // 最後のstepはToolを呼ばず、文章も書いていない。
    expect(turn.respondMissing).toEqual(['EMPTY_STEP']);
  });

  it('records a step that answered with text instead of a tool', async () => {
    const { model } = scriptedModel([
      [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'こんにちは' },
        finish,
      ],
    ]);
    const recorder = createEvalModelRecorder();
    await drain((await recorder.wrap(model).doStream({ prompt: basePrompt })).stream);
    expect(recorder.takeTurn().respondMissing).toEqual(['TEXT_WITHOUT_RESPOND']);
  });

  it('sends a system prompt variant in place of the production prompt', async () => {
    const { model, prompts } = scriptedModel([[finish], [finish]]);
    const recorder = createEvalModelRecorder();
    const wrapped = recorder.wrap(model);
    await drain((await wrapped.doStream({ prompt: basePrompt })).stream);
    recorder.setVariant({ systemPrompt: '評価用の案' });
    await drain((await wrapped.doStream({ prompt: basePrompt })).stream);

    expect(prompts[0]?.[0]).toEqual({ role: 'system', content: MODEL_SYSTEM_PROMPT });
    expect(prompts[1]?.[0]).toEqual({ role: 'system', content: '評価用の案' });
    expect(prompts[1]?.[1]).toEqual(basePrompt[1]);
  });

  it('fails loudly when the production prompt is absent, instead of testing another prompt', async () => {
    const { model } = scriptedModel([[finish]]);
    const recorder = createEvalModelRecorder();
    recorder.setVariant({ systemPrompt: '評価用の案' });
    await expect(
      recorder.wrap(model).doStream({ prompt: [{ role: 'system', content: '別の指示' }] }),
    ).rejects.toBeInstanceOf(EvalVariantNotAppliedError);
    // モデルは呼ばれず、案を適用できなかったことが記録に残る。
    const turn = recorder.takeTurn();
    expect(turn.evalError).toBe('SYSTEM_PROMPT_NOT_FOUND');
    expect(turn.modelCalls).toEqual([]);
    expect(recorder.takeTurn().evalError).toBeNull();
  });

  it('records a stream that fails midway as a failed call, not as a skipped respond', async () => {
    const model: RuntimeModelGuardModel = {
      specificationVersion: 'v3',
      provider: 'eval-recorder-test',
      modelId: 'broken-stream',
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error('generate is not scripted')),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<RuntimeModelGuardStreamPart>({
            start(controller) {
              controller.enqueue({ type: 'text-start', id: 't' });
              controller.error(new Error('connection reset'));
            },
          }),
        }),
    };
    const recorder = createEvalModelRecorder();
    await expect(
      drain((await recorder.wrap(model).doStream({ prompt: basePrompt })).stream),
    ).rejects.toThrow('connection reset');
    const turn = recorder.takeTurn();
    expect(turn.modelCalls.map((call) => call.failure)).toEqual(['stream_failed']);
    expect(turn.respondMissing).toEqual([]);
  });

  it('records a stream the runtime cancelled as aborted', async () => {
    const { model } = scriptedModel([[toolCall('call-1', 'search_places', '{}'), finish]]);
    const recorder = createEvalModelRecorder();
    const { stream } = await recorder.wrap(model).doStream({ prompt: basePrompt });
    await stream.cancel('MODEL_STREAM_TIMEOUT');
    expect(recorder.takeTurn().modelCalls.map((call) => call.failure)).toEqual(['aborted']);
  });

  it('records an error part as a failed stream', async () => {
    const { model } = scriptedModel([[{ type: 'error', error: 'provider error' }, finish]]);
    const recorder = createEvalModelRecorder();
    await drain((await recorder.wrap(model).doStream({ prompt: basePrompt })).stream);
    expect(recorder.takeTurn().modelCalls.map((call) => call.failure)).toEqual(['stream_failed']);
  });

  it('records generate calls and failed model calls', async () => {
    const generated: RuntimeModelGuardGenerateResult = {
      content: [
        { type: 'tool-call', toolCallId: 'g-1', toolName: 'respond', input: '{"input":{}}' },
      ],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: finish.usage,
      warnings: [],
    };
    const model: RuntimeModelGuardModel = {
      specificationVersion: 'v3',
      provider: 'eval-recorder-test',
      modelId: 'generate',
      supportedUrls: {},
      doGenerate: () => Promise.resolve(generated),
      doStream: () => Promise.reject(new Error('upstream unavailable')),
    };
    const recorder = createEvalModelRecorder();
    const wrapped = recorder.wrap(model);
    await wrapped.doGenerate({ prompt: basePrompt });
    await expect(wrapped.doStream({ prompt: basePrompt })).rejects.toThrow('upstream unavailable');

    const turn = recorder.takeTurn();
    expect(turn.toolCalls).toEqual([{ name: 'respond', args: { input: {} }, result: null }]);
    expect(turn.modelCalls.map((call) => [call.toolNames, call.failure])).toEqual([
      [['respond'], null],
      [[], 'call_failed'],
    ]);
    // 失敗した呼び出しはエラーであり、respondを飛ばしたstepではない。
    expect(turn.respondMissing).toEqual([]);
  });
});
