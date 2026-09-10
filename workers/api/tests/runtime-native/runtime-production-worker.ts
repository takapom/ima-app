import type { RetentionMetadata } from '@ima/core';
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

export type RuntimeProductionReport = {
  readonly calls: number;
  readonly providerOptionsSeen: readonly RuntimeProductionProviderOptions[];
  readonly toolNames: readonly string[];
  readonly finalResponseFlags: readonly boolean[];
  readonly fetchUrls: readonly string[];
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
  finalResponseFlags: boolean[];
  fetchUrls: string[];
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

const modelForProduction = (report: MutableRuntimeProductionReport): RuntimeGateModel => ({
  specificationVersion: 'v3',
  provider: 'm16-production-scripted-provider',
  modelId: 'm16-production-default-plan',
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error('M16_PRODUCTION_STREAM_ONLY')),
  doStream: (options: RuntimeGateModelCallOptions) => {
    const prompt = JSON.stringify(options.prompt);
    if (prompt.includes('[m16-final-reserve]')) {
      report.calls += 1;
      report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
      report.toolNames.push('final_message');
      return Promise.resolve({ stream: streamOf(finalMessageParts()) });
    }
    const candidateIds = candidateIdsIn(prompt);
    const observationIds = observationIdsIn(prompt);
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
                displayName: { text: 'Production Cafe' },
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
                  weekdayDescriptions: ['毎日 9:00–23:00'],
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
          displayName: { text: 'Production Cafe' },
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
            weekdayDescriptions: ['毎日 9:00–23:00'],
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

  getRuntimeProductionReport(): RuntimeProductionReport | null {
    return this.productionReport === null ? null : structuredClone(this.productionReport);
  }

  protected override createRuntimeProductionOverrides() {
    const report: MutableRuntimeProductionReport = {
      calls: 0,
      providerOptionsSeen: [],
      toolNames: [],
      finalResponseFlags: [],
      fetchUrls: [],
    };
    this.productionReport = report;
    const policy = () => ({
      freshUntil: ALLOW_RETENTION.freshUntil,
      expiresAt: ALLOW_RETENTION.retentionUntil,
      retention: ALLOW_RETENTION,
    });
    const budgetStart = performance.now();
    let finalResponseMode = false;
    return {
      modelForTurn: modelForProduction(report),
      fetcher: fetcherForProduction(report),
      observationPolicy: policy,
      detailsObservationPolicy: policy,
      placesEnabled: true,
      retention: ALLOW_RETENTION,
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
