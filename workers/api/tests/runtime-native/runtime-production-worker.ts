import type { ModelContextFieldPolicy, RetentionMetadata } from '@ima/core';
import { ThreadDO as ProductionThreadDOBase } from '../../src/thread-do';
import type {
  RuntimeGateModel,
  RuntimeGateModelCallOptions,
  RuntimeGateModelStreamPart,
} from '../runtime-gate/runtime-gate-provider';
import type { RuntimeModelGuardCallOptions } from '../../src/runtime/runtime-model-guard';

export const RUNTIME_PRODUCTION_NOW = '2026-09-10T12:00:00.000Z';

const ALLOW_RETENTION = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T23:00:00.000Z',
  freshUntil: '2026-09-10T18:00:00.000Z',
  displayUntil: '2026-09-10T20:00:00.000Z',
  retentionUntil: '2026-09-10T22:00:00.000Z',
  deletionScheduledAt: '2026-09-10T22:00:00.000Z',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
} satisfies RetentionMetadata;

const LLM_ONLY_RETENTION = {
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  sessionExpiresAt: '2026-09-10T23:00:00.000Z',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
} satisfies RetentionMetadata;

const LLM_INPUT_CANARY = 'M16_LLM_INPUT_CANARY';
const DENIED_FIELD_CANARY = 'M16_DENIED_FIELD_CANARY';

// This is an evaluated fixture snapshot for llm_input only. Production omits it
// until a host policy evaluator supplies an explicit, use-scoped decision.
const FIXTURE_MODEL_CONTEXT_FIELD_POLICY: ModelContextFieldPolicy = {
  evidence: {
    identity: 'allow',
    opening_hours: 'allow',
    price: 'allow',
    photos: 'allow',
    contact: 'allow',
    facilities: 'allow',
    walking_route: 'allow',
    last_train: 'allow',
  },
  history: 'deny',
  cardSet: 'deny',
  displayName: 'deny',
};

const LLM_ONLY_MODEL_CONTEXT_FIELD_POLICY: ModelContextFieldPolicy = {
  ...FIXTURE_MODEL_CONTEXT_FIELD_POLICY,
  evidence: { ...FIXTURE_MODEL_CONTEXT_FIELD_POLICY.evidence, opening_hours: 'deny' },
};

export type RuntimeProductionReport = {
  readonly calls: number;
  readonly providerOptionsSeen: readonly RuntimeProductionProviderOptions[];
  readonly toolNames: readonly string[];
  readonly observationIdsSeen: readonly (readonly string[])[];
  readonly finalResponseFlags: readonly boolean[];
  readonly fetchUrls: readonly string[];
  readonly llmInputCanarySeen: boolean;
  readonly deniedFieldCanarySeen: boolean;
};

export type RuntimeProductionProviderOptions = {
  readonly openai: {
    readonly reasoningEffort?: string;
    readonly strictJsonSchema?: boolean;
    readonly store?: boolean;
  };
};

type MutableRuntimeProductionReport = {
  calls: number;
  providerOptionsSeen: RuntimeProductionProviderOptions[];
  toolNames: string[];
  observationIdsSeen: string[][];
  finalResponseFlags: boolean[];
  fetchUrls: string[];
  llmInputCanarySeen: boolean;
  deniedFieldCanarySeen: boolean;
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
  openNow: true,
  limit: 1,
  excludeCandidateIds: [],
};

const candidateIdsIn = (prompt: string): string[] =>
  [...prompt.matchAll(/"candidateId":"([^"]+)"/gu)].map((match) => match[1] ?? '');

const observationIdsIn = (prompt: string): string[] =>
  [...prompt.matchAll(/"observationId":"([^"]+)"/gu)].map((match) => match[1] ?? '');

const runtimeTurnUsesLlmOnlyPolicy = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || !('input' in value)) return false;
  const input = value.input;
  if (typeof input !== 'object' || input === null || !('text' in input)) return false;
  return typeof input.text === 'string' && input.text.includes('[m16-llm-only]');
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

const envelope = (input: unknown): string => JSON.stringify({ input, metadata: {} });

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

const finalMessageParts = (): RuntimeGateModelStreamPart[] => {
  const envelope = JSON.stringify({
    kind: 'final_message',
    message: { text: '条件を確認しました。', evidenceIds: [], basis: 'conversational' },
  });
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'production-final' },
    { type: 'text-delta', id: 'production-final', delta: envelope },
    { type: 'text-end', id: 'production-final' },
    { type: 'finish', usage, finishReason: stopFinish },
  ];
};

const modelForProduction = (
  report: MutableRuntimeProductionReport,
  finalAfterDetails = false,
): RuntimeGateModel => ({
  specificationVersion: 'v3',
  provider: 'm16-production-scripted-provider',
  modelId: 'm16-production-default-plan',
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error('M16_PRODUCTION_STREAM_ONLY')),
  doStream: (options: RuntimeGateModelCallOptions) => {
    const prompt = JSON.stringify(options.prompt);
    report.llmInputCanarySeen ||= prompt.includes(LLM_INPUT_CANARY);
    report.deniedFieldCanarySeen ||= prompt.includes(DENIED_FIELD_CANARY);
    if (prompt.includes('[m16-final-reserve]')) {
      report.calls += 1;
      report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
      report.toolNames.push('final_message');
      return Promise.resolve({ stream: streamOf(finalMessageParts()) });
    }
    const candidateIds = candidateIdsIn(prompt);
    const observationIds = observationIdsIn(prompt);
    report.observationIdsSeen.push(observationIds);
    if (finalAfterDetails && report.calls >= 2) {
      report.calls += 1;
      report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
      report.toolNames.push('final_message');
      return Promise.resolve({ stream: streamOf(finalMessageParts()) });
    }
    const candidateId = candidateIds.at(-1) ?? 'missing-candidate';
    const evidenceIds = observationIds.slice(-2);
    let input: unknown;
    let toolName: string;
    const phase = report.calls % 3;
    if (phase === 0) {
      toolName = 'search_places';
      input = searchInput;
    } else if (phase === 1) {
      toolName = 'get_place_details';
      input = {
        requests: [{ candidateId, fields: ['identity', 'opening_hours'] }],
        freshness: 'refresh',
      };
    } else {
      toolName = 'submit_cards';
      input = {
        message: [{ text: '渋谷の候補です。', evidenceIds, basis: 'grounded' }],
        hero: {
          candidateId,
          evidenceIds,
          why: {
            text: '検索結果と詳細を確認しました。',
            evidenceIds,
            basis: 'grounded',
          },
        },
        alts: [],
      };
    }
    report.calls += 1;
    report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
    report.toolNames.push(toolName);
    return Promise.resolve({ stream: streamOf(toolParts(report.calls, toolName, input)) });
  },
});

const fetcherForProduction =
  (report: MutableRuntimeProductionReport): typeof fetch =>
  (input, init) => {
    report.fetchUrls.push(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    );
    const request = new Request(input, init);
    if (request.url.endsWith('/v1/places:searchText')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            places: [
              {
                id: 'm16-production-place',
                displayName: { text: LLM_INPUT_CANARY },
                formattedAddress: '東京都渋谷区',
                primaryType: 'cafe',
                businessStatus: 'OPERATIONAL',
                googleMapsUri: 'https://maps.google.com/?cid=m16-production',
                currentOpeningHours: {
                  periods: [
                    {
                      open: { date: { year: 2026, month: 9, day: 10 }, hour: 9, minute: 0 },
                      close: { date: { year: 2026, month: 9, day: 10 }, hour: 23, minute: 0 },
                    },
                  ],
                  weekdayDescriptions: [DENIED_FIELD_CANARY],
                  nextCloseTime: '2026-09-10T14:00:00.000Z',
                  openNow: true,
                },
                timeZone: { id: 'Asia/Tokyo' },
                attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'm16-production-place',
          displayName: { text: LLM_INPUT_CANARY },
          formattedAddress: '東京都渋谷区',
          primaryType: 'cafe',
          businessStatus: 'OPERATIONAL',
          googleMapsUri: 'https://maps.google.com/?cid=m16-production',
          currentOpeningHours: {
            periods: [
              {
                open: { date: { year: 2026, month: 9, day: 10 }, hour: 9, minute: 0 },
                close: { date: { year: 2026, month: 9, day: 10 }, hour: 23, minute: 0 },
              },
            ],
            weekdayDescriptions: [DENIED_FIELD_CANARY],
            nextCloseTime: '2026-09-10T14:00:00.000Z',
            openNow: true,
          },
          timeZone: { id: 'Asia/Tokyo' },
          attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };

export class ProductionThreadDO extends ProductionThreadDOBase {
  override maxSteps = 6;
  private productionReport: MutableRuntimeProductionReport | null = null;
  private llmOnlyModel = false;

  override async runRuntimeTurn(value: unknown) {
    this.llmOnlyModel = runtimeTurnUsesLlmOnlyPolicy(value);
    return super.runRuntimeTurn(value);
  }

  getRuntimeProductionReport(): RuntimeProductionReport | null {
    return this.productionReport === null ? null : structuredClone(this.productionReport);
  }

  getRuntimeAnchorStatus():
    { readonly status: 'valid' } | { readonly status: 'invalid'; readonly code: string } {
    try {
      this.ensureRuntimeThinkConnection();
      return { status: 'valid' };
    } catch (error: unknown) {
      return {
        status: 'invalid',
        code: error instanceof Error ? error.message : 'UNKNOWN_RUNTIME_ANCHOR_ERROR',
      };
    }
  }

  protected override createRuntimeProductionOverrides() {
    const report: MutableRuntimeProductionReport = {
      calls: 0,
      providerOptionsSeen: [],
      toolNames: [],
      observationIdsSeen: [],
      finalResponseFlags: [],
      fetchUrls: [],
      llmInputCanarySeen: false,
      deniedFieldCanarySeen: false,
    };
    this.productionReport = report;
    const retention = this.llmOnlyModel ? LLM_ONLY_RETENTION : ALLOW_RETENTION;
    const policy = () => ({
      freshUntil: retention.freshUntil ?? retention.sessionExpiresAt,
      expiresAt: retention.retentionUntil ?? retention.sessionExpiresAt,
      retention,
    });
    const budgetStart = performance.now();
    let finalResponseMode = false;
    return {
      modelForTurn: modelForProduction(report, this.llmOnlyModel),
      fetcher: fetcherForProduction(report),
      observationPolicy: policy,
      detailsObservationPolicy: policy,
      modelContextFieldPolicy: this.llmOnlyModel
        ? LLM_ONLY_MODEL_CONTEXT_FIELD_POLICY
        : FIXTURE_MODEL_CONTEXT_FIELD_POLICY,
      placesEnabled: true,
      retention,
      clock: () => RUNTIME_PRODUCTION_NOW,
      monotonicNow: () => (finalResponseMode ? budgetStart + 10_500 : performance.now()),
      epochNow: () => 1_000,
      isFinalResponse: (params: RuntimeModelGuardCallOptions) => {
        const final = JSON.stringify(params.prompt).includes('[m16-final-reserve]');
        finalResponseMode = final;
        report.finalResponseFlags.push(final);
        return final;
      },
    };
  }
}
