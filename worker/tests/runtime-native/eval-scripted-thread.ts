import type {
  RuntimeModelGuardModel,
  RuntimeModelGuardStreamPart,
} from '@worker/infrastructure/runtime/turn-execution/runtime-model-guard';
import { EvalThreadDO } from '../../tooling/eval/eval-thread-do';

/** 発話にこの印があると、受け取ったimaのシステムプロンプトの先頭をanswerで返す。 */
export const ECHO_SYSTEM_MARKER = '[echo-system]';
export const ECHO_SYSTEM_LENGTH = 12;
/** 発話にこの印があると、受け取った`search_places`のdescriptionの先頭をanswerで返す。 */
export const ECHO_TOOL_MARKER = '[echo-tool]';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

const toolParts = (call: number, toolName: string, input: unknown) => {
  const id = `eval-scripted-${toolName}-${call}`;
  const encoded = JSON.stringify({ input });
  const parts: RuntimeModelGuardStreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: encoded },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: encoded },
    { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool-calls' } },
  ];
  return new ReadableStream<RuntimeModelGuardStreamPart>({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });
};

/**
 * 実モデルの代わりに台本どおり動くモデル。検索結果が無ければ現在地周辺を検索し、
 * 候補が見えたら最初の候補を提案する。評価用Workerの配線をAPIキーなしで確かめるためだけに使う。
 */
const scriptedModel = (): RuntimeModelGuardModel => {
  let call = 0;
  return {
    specificationVersion: 'v3',
    provider: 'eval-scripted',
    modelId: 'eval-scripted',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('EVAL_SCRIPTED_STREAM_ONLY')),
    doStream: (options) => {
      call += 1;
      const prompt = JSON.stringify(options.prompt);
      // Thinkが既定のsystemを先頭に足すため、imaのシステムプロンプトは最後のsystemになる。
      const system = options.prompt.filter((message) => message.role === 'system').at(-1);
      if (prompt.includes(ECHO_SYSTEM_MARKER)) {
        const head = system?.role === 'system' ? system.content.slice(0, ECHO_SYSTEM_LENGTH) : '';
        return Promise.resolve({
          stream: toolParts(call, 'respond', { kind: 'answer', message: `system:${head}` }),
        });
      }
      if (prompt.includes(ECHO_TOOL_MARKER)) {
        const search = options.tools?.find((entry) => entry.name === 'search_places');
        const head =
          search?.type === 'function'
            ? (search.description ?? '').slice(0, ECHO_SYSTEM_LENGTH)
            : '';
        return Promise.resolve({
          stream: toolParts(call, 'respond', { kind: 'answer', message: `tool:${head}` }),
        });
      }
      const candidateId = /"candidateId":"([^"]+)"/u.exec(prompt)?.[1];
      if (candidateId === undefined) {
        return Promise.resolve({
          stream: toolParts(call, 'search_places', {
            mode: 'search',
            query: 'カフェ',
            area: { kind: 'current_location', radiusMeters: 1000 },
          }),
        });
      }
      return Promise.resolve({
        stream: toolParts(call, 'respond', {
          kind: 'propose',
          message: ['近くのカフェです。'],
          hero: { candidateId, why: '和パフェの掲載があり甘いものに合います' },
          alts: [],
        }),
      });
    },
  };
};

export class ScriptedEvalThreadDO extends EvalThreadDO {
  protected override evalBaseModel(): RuntimeModelGuardModel {
    return scriptedModel();
  }
}
