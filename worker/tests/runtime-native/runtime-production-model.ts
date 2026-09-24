import type { CandidateRecord } from '@worker/domain/candidates/registry';
import type {
  RuntimeGateModel,
  RuntimeGateModelCallOptions,
  RuntimeGateModelStreamPart,
} from '../support/runtime-model-fixture';
import {
  DENIED_FIELD_CANARY,
  LLM_INPUT_CANARY,
  detailsShownFor,
  type ProductionProviderFixtureReport,
  type ProductionScenario,
} from './runtime-production-provider-fixture';
import {
  modelCardSetSnapshotsIn,
  type RuntimeProductionCardSetSnapshot,
} from './runtime-production-model-observation';

export type RuntimeProductionReport = {
  readonly calls: number;
  readonly providerOptionsSeen: readonly RuntimeProductionProviderOptions[];
  readonly toolNames: readonly string[];
  readonly observationIdsSeen: readonly (readonly string[])[];
  readonly modelCandidateCounts: readonly number[];
  readonly finalResponseFlags: readonly boolean[];
  /** What each step offered the provider: the SDK's tool choice and the active tool names. */
  readonly toolChoices: readonly string[];
  readonly offeredTools: readonly (readonly string[])[];
  readonly fetchUrls: readonly string[];
  readonly searchResultCounts: readonly number[];
  readonly llmInputCanarySeen: boolean;
  readonly deniedFieldCanarySeen: boolean;
  readonly modelHistorySeen: boolean;
  readonly modelHistoryTextSeen: boolean;
  readonly modelCardSetSeen: boolean;
  readonly modelCardSetSnapshots: readonly RuntimeProductionCardSetSnapshot[];
};

export type RuntimeProductionCandidateIdentity = Pick<
  CandidateRecord,
  'provider' | 'recordRef' | 'candidateId'
>;

export type RuntimeProductionProviderOptions = {
  readonly openai: {
    readonly reasoningEffort?: string;
    readonly strictJsonSchema?: boolean;
    readonly store?: boolean;
  };
};

export type MutableRuntimeProductionReport = ProductionProviderFixtureReport & {
  calls: number;
  providerOptionsSeen: RuntimeProductionProviderOptions[];
  toolNames: string[];
  observationIdsSeen: string[][];
  modelCandidateCounts: number[];
  finalResponseFlags: boolean[];
  toolChoices: string[];
  offeredTools: string[][];
  llmInputCanarySeen: boolean;
  deniedFieldCanarySeen: boolean;
  modelHistorySeen: boolean;
  modelHistoryTextSeen: boolean;
  modelCardSetSeen: boolean;
  modelCardSetSnapshots: RuntimeProductionCardSetSnapshot[];
};

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

const toolFinish = { unified: 'tool-calls', raw: 'tool-calls' } as const;

const searchInput = {
  mode: 'search' as const,
  query: '静かなカフェ',
  area: { kind: 'named_area' as const, name: '渋谷' },
  limit: 2,
  excludeCandidateIds: [],
};

const candidateIdsIn = (prompt: string): string[] =>
  [...prompt.matchAll(/"candidateId":"([^"]+)"/gu)].map((match) => match[1] ?? '');

const observationIdsIn = (prompt: string): string[] =>
  [...prompt.matchAll(/"observationId":"([^"]+)"/gu)].map((match) => match[1] ?? '');

export const runtimeTurnUsesLlmOnlyPolicy = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || !('input' in value)) return false;
  const input = value.input;
  if (typeof input !== 'object' || input === null || !('text' in input)) return false;
  return typeof input.text === 'string' && input.text.includes('[m16-llm-only]');
};

export const runtimeTurnUsesMultiTurnPolicy = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || !('input' in value)) return false;
  const input = value.input;
  if (typeof input !== 'object' || input === null || !('text' in input)) return false;
  return (
    typeof input.text === 'string' &&
    (input.text.includes('[m16-multiturn]') ||
      input.text.includes('[m16-follow-up]') ||
      input.text.includes('[m16-condition-change]'))
  );
};

const observedProviderOptions = (
  value: RuntimeGateModelCallOptions['providerOptions'],
): RuntimeProductionProviderOptions => {
  const openai = value?.openai;
  if (typeof openai !== 'object' || openai === null || Array.isArray(openai)) {
    return { openai: {} };
  }
  return {
    openai: {
      ...(typeof openai.reasoningEffort === 'string'
        ? { reasoningEffort: openai.reasoningEffort }
        : {}),
      ...(typeof openai.strictJsonSchema === 'boolean'
        ? { strictJsonSchema: openai.strictJsonSchema }
        : {}),
      ...(typeof openai.store === 'boolean' ? { store: openai.store } : {}),
    },
  };
};

const envelope = (input: unknown): string => JSON.stringify({ input });

const toolParts = (
  call: number,
  toolName: string,
  input: unknown,
): RuntimeGateModelStreamPart[] => {
  const id = `production-${toolName}-${call}`;
  const encoded = envelope(input);
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: encoded },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: encoded },
    { type: 'finish', usage, finishReason: toolFinish },
  ];
};

const streamOf = (
  parts: readonly RuntimeGateModelStreamPart[],
): ReadableStream<RuntimeGateModelStreamPart> =>
  new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });

const answerParts = (call: number, message = '条件を確認しました。') =>
  toolParts(call, 'respond', { kind: 'answer', message });

export const modelForProduction = (
  report: MutableRuntimeProductionReport,
  finalAfterDetails = false,
  scenario: () => ProductionScenario = () => 'default',
): RuntimeGateModel => ({
  specificationVersion: 'v3',
  provider: 'm16-production-scripted-provider',
  modelId: 'm16-production-default-plan',
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error('M16_PRODUCTION_STREAM_ONLY')),
  doStream: (() => {
    let conditionChangeCalls = 0;
    return (options: RuntimeGateModelCallOptions) => {
      const prompt = JSON.stringify(options.prompt);
      report.llmInputCanarySeen ||= prompt.includes(LLM_INPUT_CANARY);
      report.deniedFieldCanarySeen ||= prompt.includes(DENIED_FIELD_CANARY);
      report.modelHistorySeen ||= prompt.includes('history\\":[{');
      report.modelHistoryTextSeen ||= prompt.includes('[m16-multiturn] 静かなカフェを探して');
      report.modelCardSetSeen ||= prompt.includes('cardSet\\":{');
      report.modelCardSetSnapshots.push(...modelCardSetSnapshotsIn(prompt));
      const offered = (options.tools ?? []).map((tool) => tool.name).sort();
      report.offeredTools.push(offered);
      report.toolChoices.push(options.toolChoice?.type ?? 'unset');
      const finalOnly = offered.length === 1 && offered[0] === 'respond';
      report.finalResponseFlags.push(finalOnly);
      if (finalOnly && scenario() === 'late-tool') {
        report.calls += 1;
        report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
        report.toolNames.push('search_places');
        return Promise.resolve({
          stream: streamOf(toolParts(report.calls, 'search_places', searchInput)),
        });
      }
      if (finalOnly) {
        report.calls += 1;
        report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
        report.toolNames.push('respond');
        return Promise.resolve({ stream: streamOf(answerParts(report.calls)) });
      }
      const candidateIds = candidateIdsIn(prompt);
      const observationIds = observationIdsIn(prompt);
      report.modelCandidateCounts.push(new Set(candidateIds).size);
      report.observationIdsSeen.push(observationIds);
      if (scenario() === 'zero-results' && report.calls > 0) {
        report.calls += 1;
        report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
        report.toolNames.push('respond');
        return Promise.resolve({
          stream: streamOf(answerParts(report.calls, '条件に合う候補は見つかりませんでした。')),
        });
      }
      if (scenario() === 'follow-up') {
        report.calls += 1;
        report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
        report.toolNames.push('respond');
        return Promise.resolve({
          stream: streamOf(answerParts(report.calls, '前の候補を維持します。')),
        });
      }
      if (finalAfterDetails && report.calls >= 2) {
        report.calls += 1;
        report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
        report.toolNames.push('respond');
        return Promise.resolve({ stream: streamOf(answerParts(report.calls)) });
      }
      const uniqueCandidateIds = [...new Set(candidateIds)];
      const twoCandidates =
        scenario() === 'two-results' ? uniqueCandidateIds.slice(-2) : ([] as string[]);
      // A candidate is committable once its details were read into the prompt.
      const wasRead = (candidate: string): boolean => detailsShownFor(prompt, candidate);
      const candidateId = twoCandidates.at(-1) ?? candidateIds.at(-1) ?? 'missing-candidate';
      let input: unknown;
      let toolName: string;
      const conditionChange = scenario() === 'condition-change';
      const phase = conditionChange ? conditionChangeCalls++ % 3 : report.calls % 3;
      if (phase === 0) {
        toolName = 'search_places';
        input = searchInput;
      } else if (phase === 1) {
        toolName = 'get_place_details';
        const detailFields =
          scenario() === 'photo'
            ? (['identity', 'opening_hours', 'photos'] as const)
            : (['identity', 'opening_hours'] as const);
        input = {
          requests: (twoCandidates.length === 2 ? twoCandidates : [candidateId]).map(
            (requestedCandidateId) => ({
              candidateId: requestedCandidateId,
              fields: detailFields,
            }),
          ),
          freshness: 'refresh',
        };
      } else {
        toolName = 'respond';
        const alternativeCandidateId = twoCandidates.find((id) => id !== candidateId);
        const bothRead =
          alternativeCandidateId !== undefined &&
          wasRead(candidateId) &&
          wasRead(alternativeCandidateId);
        input = {
          kind: 'propose',
          message: ['渋谷の候補です。'],
          hero: { candidateId, why: '検索結果と詳細を確認しました。' },
          alts: bothRead
            ? [
                {
                  candidateId: alternativeCandidateId,
                  why: 'もう一つの候補です。',
                  diff: '条件との違いを比較しました。',
                },
              ]
            : [],
        };
      }
      report.calls += 1;
      report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
      report.toolNames.push(toolName);
      return Promise.resolve({ stream: streamOf(toolParts(report.calls, toolName, input)) });
    };
  })(),
});
