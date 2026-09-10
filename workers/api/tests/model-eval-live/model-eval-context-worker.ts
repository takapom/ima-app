import type {
  CandidateRecord,
  GetPlaceDetailsInput,
  ModelContextFieldPolicy,
  SearchPlacesInput,
  SubmitCardsInput,
} from '@ima/core';
import { ProductionThreadDO } from '../runtime-native/runtime-production-worker';
import type {
  RuntimeGateModel,
  RuntimeGateModelCallOptions,
  RuntimeGateModelStreamPart,
} from '../runtime-gate/runtime-gate-provider';
import { fixedPlacesFetcher, MODEL_EVAL_NOW } from './model-eval-place-fixture';
import { LiveTraceRecorder } from '../../tooling/model-eval/live';
import {
  candidateOrderIn,
  candidateIdsIn,
  evidenceFor,
  modelUserTextIn,
  observationFieldsFor,
  type ProjectedObservation,
} from './model-eval-context-values';

export type ModelEvalFixturePhase = 'cards' | 'message';
export type ModelEvalFixtureStep =
  'search_places' | 'get_place_details' | 'submit_cards' | 'final_message';

export type ModelEvalFixtureEvidenceSnapshot = {
  readonly candidateId: string;
  readonly evidenceIds: readonly string[];
  readonly observations: readonly ProjectedObservation[];
};

const FIXTURE_MODEL_CONTEXT_FIELD_POLICY: ModelContextFieldPolicy = {
  evidence: {
    identity: 'allow',
    opening_hours: 'allow',
    price: 'allow',
    photos: 'deny',
    contact: 'deny',
    facilities: 'deny',
    walking_route: 'deny',
    last_train: 'deny',
  },
  history: 'allow',
  cardSet: 'allow',
  displayName: 'allow',
};

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

const toolFinish = { unified: 'tool-calls', raw: 'tool-calls' } as const;
const stopFinish = { unified: 'stop', raw: 'stop' } as const;

const streamOf = (
  parts: readonly RuntimeGateModelStreamPart[],
): ReadableStream<RuntimeGateModelStreamPart> =>
  new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });

const toolParts = (
  call: number,
  toolName: string,
  input: SearchPlacesInput | GetPlaceDetailsInput | SubmitCardsInput,
): RuntimeGateModelStreamPart[] => {
  const id = `model-eval-fixture-${toolName}-${call}`;
  const encoded = JSON.stringify({ input, metadata: {} });
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: encoded },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: encoded },
    { type: 'finish', usage, finishReason: toolFinish },
  ];
};

const finalParts = (text: string, evidenceIds: readonly string[]): RuntimeGateModelStreamPart[] => {
  const encoded = JSON.stringify({
    kind: 'final_message',
    message: { text, evidenceIds, basis: 'grounded' },
  });
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'model-eval-fixture-final' },
    { type: 'text-delta', id: 'model-eval-fixture-final', delta: encoded },
    { type: 'text-end', id: 'model-eval-fixture-final' },
    { type: 'finish', usage, finishReason: stopFinish },
  ];
};

const submitInputFor = (prompt: RuntimeGateModelCallOptions['prompt']): SubmitCardsInput => {
  const selections = candidateIdsIn(prompt)
    .map((candidateId) => ({ candidateId, evidenceIds: evidenceFor(prompt, candidateId) }))
    .filter((candidate) => candidate.evidenceIds.length > 0)
    .slice(0, 3);
  const fallback = selections[0];
  if (fallback === undefined) throw new Error('M25_FIXTURE_CONTEXT_MISSING');
  const selectionFor = (candidate: (typeof selections)[number]) => ({
    candidateId: candidate.candidateId,
    evidenceIds: [...candidate.evidenceIds],
    why: {
      text: '固定fixtureの公開根拠を確認しました。',
      evidenceIds: [...candidate.evidenceIds],
      basis: 'grounded' as const,
    },
  });
  const alternatives = selections.slice(1).map((candidate) => ({
    ...selectionFor(candidate),
    diff: {
      text: '別候補として比較できます。',
      evidenceIds: [...candidate.evidenceIds],
      basis: 'grounded' as const,
    },
  }));
  return {
    message: [
      {
        text: '固定fixtureの候補を提示します。',
        evidenceIds: [...fallback.evidenceIds],
        basis: 'grounded',
      },
    ],
    hero: selectionFor(fallback),
    alts: alternatives,
  };
};

const fixtureModel = (
  phase: () => ModelEvalFixturePhase,
  trace: LiveTraceRecorder,
  step: (name: ModelEvalFixtureStep) => void,
  detailsRequest: (candidateIds: readonly string[]) => void,
  finalEvidence: (snapshot: ModelEvalFixtureEvidenceSnapshot) => void,
): RuntimeGateModel => {
  let call = 0;
  let previousPhase: ModelEvalFixturePhase | undefined;
  return {
    specificationVersion: 'v3',
    provider: 'm25-model-eval-fixture-provider',
    modelId: 'm25-context-fixture-v1',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('M25_FIXTURE_STREAM_ONLY')),
    doStream: (options: RuntimeGateModelCallOptions) => {
      const currentPhase = phase();
      if (currentPhase !== previousPhase) {
        call = 0;
        previousPhase = currentPhase;
      }
      const prompt = options.prompt;
      trace.begin(prompt);
      trace.finish(usage);
      const currentCall = call;
      call += 1;
      const finalResponse =
        Object.keys(options.tools ?? {}).length === 0 || options.toolChoice?.type === 'none';
      const shouldRefreshMessage = currentPhase === 'message' && currentCall === 0;
      if (!shouldRefreshMessage && (currentPhase === 'message' || finalResponse)) {
        step('final_message');
        const candidates =
          currentPhase === 'message' ? candidateOrderIn(prompt) : candidateIdsIn(prompt);
        const candidate = candidates
          .map((candidateId) => ({ candidateId, evidenceIds: evidenceFor(prompt, candidateId) }))
          .find((item) => item.evidenceIds.length > 0);
        const userText = modelUserTextIn(prompt);
        const requestedIndex = userText.includes('2つ目') ? 1 : 0;
        const requestedCandidateId = candidates[requestedIndex] ?? candidates[0];
        const requestedCandidate = candidates
          .map((candidateId) => ({
            candidateId,
            evidenceIds: evidenceFor(prompt, candidateId),
          }))
          .find((item) => item.candidateId === requestedCandidateId && item.evidenceIds.length > 0);
        const selectedCandidate =
          currentPhase === 'message' ? requestedCandidate : (requestedCandidate ?? candidate);
        if (selectedCandidate === undefined) throw new Error('M25_FIXTURE_CONTEXT_MISSING');
        const candidateId = selectedCandidate.candidateId;
        finalEvidence({
          candidateId,
          evidenceIds: [...selectedCandidate.evidenceIds],
          observations: candidates.flatMap((id) => observationFieldsFor(prompt, id)),
        });
        return Promise.resolve({
          stream: streamOf(
            finalParts(`${candidateId}の公開根拠を確認しました。`, selectedCandidate.evidenceIds),
          ),
        });
      }
      if (shouldRefreshMessage) {
        step('get_place_details');
        const userText = modelUserTextIn(prompt);
        const candidates = candidateOrderIn(prompt);
        const requestedIndex = userText.includes('2つ目') ? 1 : 0;
        const candidateId = candidates[requestedIndex] ?? candidates[0];
        if (candidateId === undefined) throw new Error('M25_FIXTURE_CONTEXT_MISSING');
        detailsRequest([candidateId]);
        return Promise.resolve({
          stream: streamOf(
            toolParts(currentCall, 'get_place_details', {
              requests: [
                {
                  candidateId,
                  fields: ['identity', 'opening_hours', 'price'],
                },
              ],
              freshness: 'refresh',
            }),
          ),
        });
      }
      if (currentCall === 0) {
        step('search_places');
        return Promise.resolve({
          stream: streamOf(
            toolParts(currentCall, 'search_places', {
              mode: 'search',
              query: '静かなカフェ',
              area: { kind: 'named_area', name: '渋谷' },
              openNow: false,
              limit: 3,
              excludeCandidateIds: [],
            }),
          ),
        });
      }
      if (currentCall === 1) {
        step('get_place_details');
        const candidates = candidateIdsIn(prompt).slice(0, 3);
        detailsRequest(candidates);
        return Promise.resolve({
          stream: streamOf(
            toolParts(currentCall, 'get_place_details', {
              requests: candidates.map((candidateId) => ({
                candidateId,
                fields: ['identity', 'opening_hours', 'price'],
              })),
              freshness: 'refresh',
            }),
          ),
        });
      }
      step('submit_cards');
      const candidates = candidateIdsIn(prompt).slice(0, 3);
      for (const candidateId of candidates) {
        const evidenceIds = evidenceFor(prompt, candidateId);
        if (evidenceIds.length === 0) continue;
        finalEvidence({
          candidateId,
          evidenceIds: [...evidenceIds],
          observations: candidates.flatMap((id) => observationFieldsFor(prompt, id)),
        });
      }
      return Promise.resolve({
        stream: streamOf(toolParts(currentCall, 'submit_cards', submitInputFor(prompt))),
      });
    },
  };
};

export class ModelEvalFixtureThreadDO extends ProductionThreadDO {
  private fixturePhase: ModelEvalFixturePhase = 'cards';
  private fixtureNow = MODEL_EVAL_NOW;
  private readonly fixtureTrace = new LiveTraceRecorder();
  private readonly fixtureSteps: ModelEvalFixtureStep[] = [];
  private readonly fixtureDetailsRequests: string[][] = [];
  private readonly fixtureEvidenceSnapshots: ModelEvalFixtureEvidenceSnapshot[] = [];

  configureModelEvalFixture(phase: ModelEvalFixturePhase, now = MODEL_EVAL_NOW): void {
    this.fixturePhase = phase;
    this.fixtureNow = now;
  }

  protected override runtimeProductionNow(): string {
    return this.fixtureNow;
  }

  getModelEvalFixtureTrace() {
    return this.fixtureTrace.snapshot();
  }

  getModelEvalFixtureSteps(): readonly ModelEvalFixtureStep[] {
    return [...this.fixtureSteps];
  }

  getModelEvalFixtureCandidateIdentities() {
    return this.fixtureTrace.snapshot().candidateIdentities;
  }

  getModelEvalFixtureDetailsRequests(): readonly (readonly string[])[] {
    return this.fixtureDetailsRequests.map((candidateIds) => [...candidateIds]);
  }

  getModelEvalFixtureEvidenceSnapshots(): readonly ModelEvalFixtureEvidenceSnapshot[] {
    return this.fixtureEvidenceSnapshots.map((snapshot) => ({
      candidateId: snapshot.candidateId,
      evidenceIds: [...snapshot.evidenceIds],
      observations: snapshot.observations.map((observation) => ({ ...observation })),
    }));
  }

  protected override createRuntimeProductionOverrides() {
    const base = super.createRuntimeProductionOverrides();
    return {
      ...base,
      modelForTurn: fixtureModel(
        () => this.fixturePhase,
        this.fixtureTrace,
        (step) => this.fixtureSteps.push(step),
        (candidateIds) => this.fixtureDetailsRequests.push([...candidateIds]),
        (snapshot) => this.fixtureEvidenceSnapshots.push(snapshot),
      ),
      modelContextFieldPolicy: FIXTURE_MODEL_CONTEXT_FIELD_POLICY,
      candidateIdentityObserver: (
        record: Pick<CandidateRecord, 'provider' | 'recordRef' | 'candidateId'>,
      ) => this.fixtureTrace.observeCandidateIdentity(record),
      fetcher: (input: RequestInfo | URL, init?: RequestInit) =>
        fixedPlacesFetcher(this.fixtureTrace, this.fixtureNow)(input, init),
      googlePlacesApiKey: 'model-eval-fixed-provider-key',
      placesCursorSecret: 'model-eval-fixed-cursor-secret',
      placesEnabled: true,
      clock: () => this.fixtureNow,
      epochNow: () => Date.parse(this.fixtureNow),
    };
  }
}

export default {
  fetch(): Response {
    return new Response('model-eval-context worker', { status: 404 });
  },
};
