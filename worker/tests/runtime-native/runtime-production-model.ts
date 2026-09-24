import type { CandidateRecord } from '@worker/domain/candidates/registry';
import type {
  RuntimeGateModel,
  RuntimeGateModelCallOptions,
  RuntimeGateModelStreamPart,
} from '../support/runtime-model-fixture';
import {
  DENIED_FIELD_CANARY,
  LLM_INPUT_CANARY,
  observationIdsForCandidateIn,
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
const stopFinish = { unified: 'stop', raw: 'stop' } as const;

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

const finalMessageParts = (
  text = '条件を確認しました。',
  evidenceIds: readonly string[] = [],
): RuntimeGateModelStreamPart[] => {
  const envelope = JSON.stringify({
    kind: 'final_message',
    message: {
      text,
      evidenceIds,
      basis: evidenceIds.length > 0 ? 'grounded' : 'conversational',
    },
  });
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'production-final' },
    { type: 'text-delta', id: 'production-final', delta: envelope },
    { type: 'text-end', id: 'production-final' },
    { type: 'finish', usage, finishReason: stopFinish },
  ];
};

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
      const finalOnly =
        Object.keys(options.tools ?? {}).length === 0 || options.toolChoice?.type === 'none';
      report.finalResponseFlags.push(finalOnly);
      if (finalOnly && (scenario() === 'late-tool' || scenario() === 'late-submit')) {
        const toolName = scenario() === 'late-submit' ? 'submit_cards' : 'search_places';
        report.calls += 1;
        report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
        report.toolNames.push(toolName);
        return Promise.resolve({
          stream: streamOf(toolParts(report.calls, toolName, searchInput)),
        });
      }
      if (finalOnly) {
        report.calls += 1;
        report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
        report.toolNames.push('final_message');
        return Promise.resolve({ stream: streamOf(finalMessageParts()) });
      }
      const candidateIds = candidateIdsIn(prompt);
      const observationIds = observationIdsIn(prompt);
      report.modelCandidateCounts.push(new Set(candidateIds).size);
      report.observationIdsSeen.push(observationIds);
      if (scenario() === 'zero-results' && report.calls > 0) {
        report.calls += 1;
        report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
        report.toolNames.push('final_message');
        return Promise.resolve({
          stream: streamOf(finalMessageParts('条件に合う候補は見つかりませんでした。')),
        });
      }
      if (scenario() === 'follow-up') {
        report.calls += 1;
        report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
        report.toolNames.push('final_message');
        return Promise.resolve({
          stream: streamOf(finalMessageParts('前の候補を維持します。', observationIds.slice(-2))),
        });
      }
      if (finalAfterDetails && report.calls >= 2) {
        report.calls += 1;
        report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
        report.toolNames.push('final_message');
        return Promise.resolve({ stream: streamOf(finalMessageParts()) });
      }
      const uniqueCandidateIds = [...new Set(candidateIds)];
      const twoCandidates =
        scenario() === 'two-results' ? uniqueCandidateIds.slice(-2) : ([] as string[]);
      const evidenceFor = (candidate: string): string[] =>
        observationIdsForCandidateIn(prompt, candidate).slice(scenario() === 'photo' ? -3 : -2);
      const candidateId = twoCandidates.at(-1) ?? candidateIds.at(-1) ?? 'missing-candidate';
      const evidenceIds = evidenceFor(candidateId).length
        ? evidenceFor(candidateId)
        : observationIds.slice(-2);
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
        toolName = 'submit_cards';
        const alternativeCandidateId = twoCandidates.find((id) => id !== candidateId);
        const alternativeEvidenceIds =
          alternativeCandidateId === undefined ? [] : evidenceFor(alternativeCandidateId);
        const selectionsAreGrounded =
          twoCandidates.length === 2 && evidenceIds.length > 0 && alternativeEvidenceIds.length > 0;
        input = {
          message: [
            {
              text: '渋谷の候補です。',
              evidenceIds: selectionsAreGrounded
                ? [...new Set([...evidenceIds, ...alternativeEvidenceIds])]
                : evidenceIds,
              basis: 'grounded',
            },
          ],
          hero: {
            candidateId,
            evidenceIds,
            why: {
              text: '検索結果と詳細を確認しました。',
              evidenceIds,
              basis: 'grounded',
            },
          },
          alts: selectionsAreGrounded
            ? [
                {
                  candidateId: alternativeCandidateId,
                  evidenceIds: alternativeEvidenceIds,
                  why: {
                    text: 'もう一つの候補です。',
                    evidenceIds: alternativeEvidenceIds,
                    basis: 'grounded',
                  },
                  diff: {
                    text: '条件との違いを比較しました。',
                    evidenceIds: alternativeEvidenceIds,
                    basis: 'grounded',
                  },
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
