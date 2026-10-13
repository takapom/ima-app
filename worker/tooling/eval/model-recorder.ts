import { wrapLanguageModel } from 'ai';
import { toolInputInvalidFields } from '@worker/infrastructure/runtime/model/tool-input-error';
import type {
  RuntimeModelGuardCallOptions,
  RuntimeModelGuardGenerateResult,
  RuntimeModelGuardModel,
  RuntimeModelGuardStreamPart,
} from '@worker/infrastructure/runtime/turn-execution/runtime-model-guard';
import type { EvalModelCall, EvalToolCall, EvalToolResult, EvalTurnRecord } from './eval-contract';
import { applyVariant, EvalVariantNotAppliedError, type EvalVariant } from './variants';

type PromptMessage = RuntimeModelGuardCallOptions['prompt'][number];
type ToolResultOutput = Extract<
  Extract<PromptMessage, { role: 'tool' }>['content'][number],
  { type: 'tool-result' }
>['output'];
type Usage = Extract<RuntimeModelGuardStreamPart, { type: 'finish' }>['usage'];
type StreamPart = RuntimeModelGuardStreamPart;
type RespondMissing = EvalTurnRecord['respondMissing'][number];
type CallFailure = EvalModelCall['failure'];
type PromptCall = { readonly name: string; readonly result: EvalToolResult | null };

export type EvalModelRecording = {
  readonly toolCalls: EvalToolCall[];
  readonly toolResultsMatched: boolean;
  readonly modelCalls: EvalModelCall[];
  readonly respondMissing: RespondMissing[];
  /** 案を適用できずにモデルを呼ばなかった理由。なければnull。 */
  readonly evalError: EvalTurnRecord['evalError'];
};

export type EvalModelRecorder = {
  readonly wrap: (model: RuntimeModelGuardModel) => RuntimeModelGuardModel;
  /** 評価する案。省略した部分は本番のまま。 */
  readonly setVariant: (variant: EvalVariant) => void;
  /** 前回の呼び出し以降にモデルが行ったことを返し、次のターンの記録を始める。 */
  readonly takeTurn: () => EvalModelRecording;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
};

const countOf = (value: unknown): number | null => (Array.isArray(value) ? value.length : null);

const summarizeValue = (value: unknown): EvalToolResult => {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return { status: 'withheld', code: null, candidates: null, issues: [] };
  }
  const error = value.error;
  const data = value.data;
  return {
    status: value.status,
    code: isRecord(error) && typeof error.code === 'string' ? error.code : null,
    candidates: isRecord(data) ? countOf(data.candidates) : null,
    issues: Array.isArray(value.issues)
      ? value.issues.flatMap((issue) =>
          isRecord(issue) && typeof issue.code === 'string' ? [issue.code] : [],
        )
      : [],
  };
};

/** 次のstepでモデルが見たTool結果を要約する。 */
export const summarizeToolResult = (output: ToolResultOutput): EvalToolResult => {
  switch (output.type) {
    case 'json':
      return summarizeValue(output.value);
    case 'text':
      return summarizeValue(parseJson(output.value));
    case 'error-text':
    case 'error-json':
      // 引数が拒否されたToolは実行されていない。契約上の項目名だけを残す。
      return {
        status: 'tool_error',
        code: null,
        candidates: null,
        issues: [
          ...(toolInputInvalidFields(
            output.type === 'error-text' ? output.value : JSON.stringify(output.value),
          ) ?? []),
        ],
      };
    case 'execution-denied':
      return { status: 'denied', code: null, candidates: null, issues: [] };
    case 'content':
      return { status: 'withheld', code: null, candidates: null, issues: [] };
  }
};

const tokens = (usage: Usage | undefined) => ({
  inputTokens: usage?.inputTokens.total ?? null,
  outputTokens: usage?.outputTokens.total ?? null,
});

type StreamEnd = 'completed' | 'failed' | 'aborted';

/**
 * ストリームを素通ししながら各partを観測し、終わり方を1度だけ知らせる。
 * TransformStreamのflushは途中の失敗や打ち切りでは呼ばれないため、読み出しを自前で行う。
 */
const observeStream = (
  source: ReadableStream<StreamPart>,
  onPart: (part: StreamPart) => void,
  onEnd: (end: StreamEnd) => void,
): ReadableStream<StreamPart> => {
  const reader = source.getReader();
  let ended = false;
  const end = (value: StreamEnd): void => {
    if (ended) return;
    ended = true;
    onEnd(value);
  };
  return new ReadableStream<StreamPart>({
    async pull(controller) {
      let next: ReadableStreamReadResult<StreamPart>;
      try {
        next = await reader.read();
      } catch (error: unknown) {
        end('failed');
        controller.error(error);
        return;
      }
      if (next.done) {
        end('completed');
        controller.close();
        return;
      }
      onPart(next.value);
      controller.enqueue(next.value);
    },
    async cancel(reason: unknown) {
      end('aborted');
      await reader.cancel(reason);
    },
  });
};

export const createEvalModelRecorder = (
  now: () => number = () => Date.now(),
): EvalModelRecorder => {
  let variant: EvalVariant = {};
  let calls: { name: string; args: unknown }[] = [];
  let promptCalls: PromptCall[] = [];
  let modelCalls: EvalModelCall[] = [];
  let respondMissing: RespondMissing[] = [];
  let evalError: EvalTurnRecord['evalError'] = null;

  /**
   * そのターンのTool呼び出しと結果を、モデルに渡るpromptから読む。
   * 保存処理がtoolCallIdを書き換えるため、モデルが出したIDではなくpromptの中の対応で結果を結ぶ。
   */
  const readPromptCalls = (prompt: RuntimeModelGuardCallOptions['prompt']): void => {
    const results = new Map<string, EvalToolResult>();
    for (const message of prompt) {
      if (message.role !== 'tool') continue;
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          results.set(part.toolCallId, summarizeToolResult(part.output));
        }
      }
    }
    const next: PromptCall[] = [];
    for (const message of prompt) {
      if (message.role !== 'assistant') continue;
      for (const part of message.content) {
        if (part.type === 'tool-call') {
          next.push({ name: part.toolName, result: results.get(part.toolCallId) ?? null });
        }
      }
    }
    // promptはstepごとに伸びるため、最も長いものがそのターンの全体になる。
    if (next.length >= promptCalls.length) promptCalls = next;
  };

  /**
   * promptの呼び出し列は、記録した呼び出し列の先頭部分になる（最後のstepの呼び出しはまだpromptに
   * 載らない）。名前の並びがそうなっているときだけ位置で結果を結び、食い違えば誤った結果を
   * 付けないよう全件をnullにする。
   */
  const matchesRecordedCalls = (): boolean =>
    promptCalls.length <= calls.length &&
    promptCalls.every((promptCall, index) => promptCall.name === calls[index]?.name);

  const finishCall = (
    started: number,
    toolNames: string[],
    sawText: boolean,
    usage: Usage | undefined,
    failure: CallFailure,
  ): void => {
    modelCalls.push({ ms: Math.max(0, now() - started), ...tokens(usage), toolNames, failure });
    // 正常に終わったのにToolを呼ばなかったstepだけが、respondを飛ばしたstepにあたる。
    if (failure === null && toolNames.length === 0) {
      respondMissing.push(sawText ? 'TEXT_WITHOUT_RESPOND' : 'EMPTY_STEP');
    }
  };

  const wrap = (model: RuntimeModelGuardModel): RuntimeModelGuardModel =>
    wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: 'v3',
        transformParams: ({ params }) => {
          readPromptCalls(params.prompt);
          try {
            return Promise.resolve(applyVariant(params, variant));
          } catch (error: unknown) {
            // モデルは呼ばれない。採点せずERRORにするため、理由を記録に残す。
            if (error instanceof EvalVariantNotAppliedError) evalError = error.reason;
            return Promise.reject(error instanceof Error ? error : new Error('variant failed'));
          }
        },
        wrapGenerate: async ({ doGenerate }) => {
          const started = now();
          let result: RuntimeModelGuardGenerateResult;
          try {
            result = await doGenerate();
          } catch (error: unknown) {
            finishCall(started, [], false, undefined, 'call_failed');
            throw error;
          }
          const toolNames: string[] = [];
          for (const part of result.content) {
            if (part.type !== 'tool-call') continue;
            calls.push({ name: part.toolName, args: parseJson(part.input) });
            toolNames.push(part.toolName);
          }
          const sawText = result.content.some((part) => part.type === 'text' && part.text !== '');
          finishCall(
            started,
            toolNames,
            sawText,
            result.usage,
            result.finishReason.unified === 'error' ? 'call_failed' : null,
          );
          return result;
        },
        wrapStream: async ({ doStream }) => {
          const started = now();
          let result: Awaited<ReturnType<RuntimeModelGuardModel['doStream']>>;
          try {
            result = await doStream();
          } catch (error: unknown) {
            finishCall(started, [], false, undefined, 'call_failed');
            throw error;
          }
          const toolNames: string[] = [];
          let sawText = false;
          let usage: Usage | undefined;
          let errorPart = false;
          const stream = observeStream(
            result.stream,
            (part) => {
              if (part.type === 'tool-call') {
                calls.push({ name: part.toolName, args: parseJson(part.input) });
                toolNames.push(part.toolName);
              } else if (part.type === 'text-delta' && part.delta !== '') {
                sawText = true;
              } else if (part.type === 'finish') {
                usage = part.usage;
                errorPart ||= part.finishReason.unified === 'error';
              } else if (part.type === 'error') {
                errorPart = true;
              }
            },
            (end) => {
              const failure: CallFailure =
                end === 'aborted'
                  ? 'aborted'
                  : end === 'failed' || errorPart
                    ? 'stream_failed'
                    : null;
              finishCall(started, toolNames, sawText, usage, failure);
            },
          );
          return { ...result, stream };
        },
      },
    });

  return {
    wrap,
    setVariant: (next) => {
      variant = next;
    },
    takeTurn: () => {
      const matched = matchesRecordedCalls();
      const recording: EvalModelRecording = {
        toolCalls: calls.map((call, index) => ({
          ...call,
          result: matched ? (promptCalls[index]?.result ?? null) : null,
        })),
        toolResultsMatched: matched,
        modelCalls,
        respondMissing,
        evalError,
      };
      calls = [];
      promptCalls = [];
      modelCalls = [];
      respondMissing = [];
      evalError = null;
      return recording;
    },
  };
};
