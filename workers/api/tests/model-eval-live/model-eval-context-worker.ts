import type { CandidateRecord, ModelContextFieldPolicy, SearchPlacesInput } from '@ima/core';
import { ProductionThreadDO } from '../runtime-native/runtime-production-worker';
import type {
  RuntimeGateModel,
  RuntimeGateModelCallOptions,
} from '../runtime-gate/runtime-gate-provider';
import { fixedPlacesFetcher, MODEL_EVAL_NOW } from './model-eval-place-fixture';
import { LiveTraceRecorder } from '../../tooling/model-eval/live';
import {
  evidenceSnapshotFor,
  finalParts,
  FIXTURE_USAGE,
  streamOf,
  submitInputFor,
  toolParts,
  type ModelEvalFixtureEvidenceSnapshot,
} from './model-eval-context-output';
import {
  candidateOrderIn,
  candidateIdsIn,
  evidenceFor,
  modelLocationIn,
  modelLocationProjectionHasCoordinates,
  modelPreferenceBudgetIn,
  modelToolErrorCodesIn,
  modelUserTextIn,
  selectedCandidateIdIn,
  type ProjectedModelLocation,
} from './model-eval-context-values';
import {
  assertConditionProjection,
  candidateLimitFor,
  searchQueryFor,
  type ModelEvalConditionFixtureProfile,
} from './condition-context-fixture';

export type ModelEvalFixturePhase = 'cards' | 'message';
export type ModelEvalFixtureProfile =
  | 'reason'
  | 'continuity'
  | 'compare'
  | 'decide-action'
  | 'clarify-ambiguity'
  | 'gps-refusal'
  | ModelEvalConditionFixtureProfile;
export type ModelEvalFixtureLocationProbe = 'clarify' | 'current-location';
export type ModelEvalFixtureStep =
  'search_places' | 'get_place_details' | 'submit_cards' | 'final_message';
export type { ModelEvalFixtureEvidenceSnapshot } from './model-eval-context-output';

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

const currentLocationSearchInput: SearchPlacesInput = {
  mode: 'search',
  query: '近くの店',
  area: { kind: 'current_location', radiusMeters: 1000 },
  openNow: false,
  limit: 3,
  excludeCandidateIds: [],
};

const fixtureModel = (
  phase: () => ModelEvalFixturePhase,
  profile: () => ModelEvalFixtureProfile,
  trace: LiveTraceRecorder,
  step: (name: ModelEvalFixtureStep) => void,
  detailsRequest: (candidateIds: readonly string[]) => void,
  finalEvidence: (snapshot: ModelEvalFixtureEvidenceSnapshot) => void,
  modelLocationExposed: () => void,
  modelLocation: (location: ProjectedModelLocation) => void,
  toolErrors: (codes: readonly string[]) => void,
  locationProbe: () => ModelEvalFixtureLocationProbe,
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
      trace.finish(FIXTURE_USAGE);
      if (modelLocationProjectionHasCoordinates(prompt)) modelLocationExposed();
      const projectedLocation = modelLocationIn(prompt);
      if (projectedLocation !== undefined) modelLocation(projectedLocation);
      const toolErrorCodes = modelToolErrorCodesIn(prompt);
      if (toolErrorCodes.length > 0) toolErrors(toolErrorCodes);
      assertConditionProjection(profile(), modelPreferenceBudgetIn(prompt));
      const currentCall = call;
      call += 1;
      const finalResponse =
        Object.keys(options.tools ?? {}).length === 0 || options.toolChoice?.type === 'none';
      const shouldRefreshMessage = currentPhase === 'message' && currentCall === 0;
      if (currentPhase === 'message' && profile() === 'gps-refusal') {
        if (locationProbe() === 'current-location' && currentCall === 0) {
          step('search_places');
          return Promise.resolve({
            stream: streamOf(toolParts(currentCall, 'search_places', currentLocationSearchInput)),
          });
        }
        step('final_message');
        return Promise.resolve({
          stream: streamOf(
            finalParts('位置情報を使わずに探すには地域を教えてください。', [], 'conversational'),
          ),
        });
      }
      if (currentPhase === 'message' && profile() === 'clarify-ambiguity') {
        step('final_message');
        return Promise.resolve({
          stream: streamOf(finalParts('どの候補を指していますか？', [], 'conversational')),
        });
      }
      if (!shouldRefreshMessage && (currentPhase === 'message' || finalResponse)) {
        step('final_message');
        const candidates =
          currentPhase === 'message' ? candidateOrderIn(prompt) : candidateIdsIn(prompt);
        const selectedCandidateId = selectedCandidateIdIn(prompt);
        if (
          currentPhase === 'message' &&
          profile() === 'decide-action' &&
          (selectedCandidateId === undefined ||
            selectedCandidateId === null ||
            !candidates.includes(selectedCandidateId))
        ) {
          throw new Error('M25_FIXTURE_SELECTION_CONTEXT_MISSING');
        }
        const candidate = candidates
          .map((candidateId) => ({ candidateId, evidenceIds: evidenceFor(prompt, candidateId) }))
          .find((item) => item.evidenceIds.length > 0);
        const requestedCandidateId =
          currentPhase === 'message' && profile() === 'decide-action'
            ? selectedCandidateId
            : (() => {
                const userText = modelUserTextIn(prompt);
                const requestedIndex = userText.includes('2つ目') ? 1 : 0;
                return candidates[requestedIndex] ?? candidates[0];
              })();
        const requestedCandidate = candidates
          .map((candidateId) => ({
            candidateId,
            evidenceIds: evidenceFor(prompt, candidateId),
          }))
          .find((item) => item.candidateId === requestedCandidateId && item.evidenceIds.length > 0);
        const selectedCandidate =
          currentPhase === 'message' ? requestedCandidate : (requestedCandidate ?? candidate);
        if (selectedCandidate === undefined) throw new Error('M25_FIXTURE_CONTEXT_MISSING');
        if (currentPhase === 'message' && profile() === 'compare') {
          const compared = candidates
            .slice(0, 2)
            .map((candidateId) => ({
              candidateId,
              evidenceIds: evidenceFor(prompt, candidateId),
            }))
            .filter((item) => item.evidenceIds.length > 0);
          if (compared.length < 2) throw new Error('M25_FIXTURE_COMPARE_CONTEXT_MISSING');
          compared.forEach((item) => finalEvidence(evidenceSnapshotFor(prompt, item.candidateId)));
          const evidenceIds = compared.flatMap((item) => item.evidenceIds);
          return Promise.resolve({
            stream: streamOf(finalParts('青葉カフェと川辺食堂を比較しました。', evidenceIds)),
          });
        }
        const candidateId = selectedCandidate.candidateId;
        finalEvidence(evidenceSnapshotFor(prompt, candidateId));
        return Promise.resolve({
          stream: streamOf(
            finalParts(`${candidateId}の公開根拠を確認しました。`, selectedCandidate.evidenceIds),
          ),
        });
      }
      if (shouldRefreshMessage) {
        step('get_place_details');
        const candidates = candidateOrderIn(prompt);
        const selectedCandidateId = selectedCandidateIdIn(prompt);
        if (
          profile() === 'decide-action' &&
          (selectedCandidateId === undefined ||
            selectedCandidateId === null ||
            !candidates.includes(selectedCandidateId))
        ) {
          throw new Error('M25_FIXTURE_SELECTION_CONTEXT_MISSING');
        }
        const requestedCandidateId =
          profile() === 'decide-action'
            ? selectedCandidateId
            : (() => {
                const userText = modelUserTextIn(prompt);
                const requestedIndex = userText.includes('2つ目') ? 1 : 0;
                return candidates[requestedIndex] ?? candidates[0];
              })();
        const requestedCandidates =
          profile() === 'compare'
            ? candidates.slice(0, 2)
            : [requestedCandidateId].filter(
                (candidateId): candidateId is string => typeof candidateId === 'string',
              );
        if (requestedCandidates.length === 0) throw new Error('M25_FIXTURE_CONTEXT_MISSING');
        detailsRequest(requestedCandidates);
        return Promise.resolve({
          stream: streamOf(
            toolParts(currentCall, 'get_place_details', {
              requests: requestedCandidates.map((candidateId) => ({
                candidateId,
                fields: ['identity', 'opening_hours', 'price'],
              })),
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
              query: searchQueryFor(profile()),
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
        const candidates = candidateIdsIn(prompt).slice(0, candidateLimitFor(profile()));
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
      const candidates = candidateIdsIn(prompt).slice(0, candidateLimitFor(profile()));
      for (const candidateId of candidates) {
        const evidenceIds = evidenceFor(prompt, candidateId);
        if (evidenceIds.length === 0) continue;
        finalEvidence(evidenceSnapshotFor(prompt, candidateId));
      }
      return Promise.resolve({
        stream: streamOf(
          toolParts(
            currentCall,
            'submit_cards',
            submitInputFor(
              prompt,
              profile() === 'decide-action'
                ? [candidates[1], candidates[0], ...candidates.slice(2)].filter(
                    (candidateId): candidateId is string => candidateId !== undefined,
                  )
                : candidates,
            ),
          ),
        ),
      });
    },
  };
};

export class ModelEvalFixtureThreadDO extends ProductionThreadDO {
  private fixturePhase: ModelEvalFixturePhase = 'cards';
  private fixtureProfile: ModelEvalFixtureProfile = 'reason';
  private fixtureNow = MODEL_EVAL_NOW;
  private fixtureLocationProbe: ModelEvalFixtureLocationProbe = 'clarify';
  private readonly fixtureToolErrorCodes: string[] = [];
  private fixtureModelLocationExposed = false;
  private readonly fixtureTrace = new LiveTraceRecorder();
  private readonly fixtureModelLocations: ProjectedModelLocation[] = [];
  private readonly fixtureSteps: ModelEvalFixtureStep[] = [];
  private readonly fixtureDetailsRequests: string[][] = [];
  private readonly fixtureSearchQueries: string[] = [];
  private readonly fixtureEvidenceSnapshots: ModelEvalFixtureEvidenceSnapshot[] = [];

  configureModelEvalFixture(
    phase: ModelEvalFixturePhase,
    now = MODEL_EVAL_NOW,
    profile: ModelEvalFixtureProfile = 'reason',
    locationProbe: ModelEvalFixtureLocationProbe = 'clarify',
  ): void {
    this.fixturePhase = phase;
    this.fixtureNow = now;
    this.fixtureProfile = profile;
    this.fixtureLocationProbe = locationProbe;
    this.fixtureToolErrorCodes.length = 0;
    this.fixtureModelLocationExposed = false;
    this.fixtureSearchQueries.length = 0;
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

  getModelEvalFixtureSearchQueries(): readonly string[] {
    return [...this.fixtureSearchQueries];
  }

  getModelEvalFixtureModelLocations(): readonly ProjectedModelLocation[] {
    return this.fixtureModelLocations.map((location) => ({ ...location }));
  }

  getModelEvalFixtureToolErrorCodes(): readonly string[] {
    return [...this.fixtureToolErrorCodes];
  }

  getModelEvalFixtureModelLocationExposed(): boolean {
    return this.fixtureModelLocationExposed;
  }

  getModelEvalFixtureEvidenceSnapshots(): readonly ModelEvalFixtureEvidenceSnapshot[] {
    return this.fixtureEvidenceSnapshots.map((snapshot) => ({
      candidateId: snapshot.candidateId,
      evidenceIds: [...snapshot.evidenceIds],
      modelBudget: snapshot.modelBudget,
      observations: snapshot.observations.map((observation) => ({ ...observation })),
    }));
  }

  protected override createRuntimeProductionOverrides() {
    const base = super.createRuntimeProductionOverrides();
    return {
      ...base,
      modelForTurn: fixtureModel(
        () => this.fixturePhase,
        () => this.fixtureProfile,
        this.fixtureTrace,
        (step) => this.fixtureSteps.push(step),
        (candidateIds) => this.fixtureDetailsRequests.push([...candidateIds]),
        (snapshot) => this.fixtureEvidenceSnapshots.push(snapshot),
        () => {
          this.fixtureModelLocationExposed = true;
        },
        (location) => this.fixtureModelLocations.push({ ...location }),
        (codes) => {
          this.fixtureToolErrorCodes.push(...codes);
        },
        () => this.fixtureLocationProbe,
      ),
      modelContextFieldPolicy: FIXTURE_MODEL_CONTEXT_FIELD_POLICY,
      candidateIdentityObserver: (
        record: Pick<CandidateRecord, 'provider' | 'recordRef' | 'candidateId'>,
      ) => this.fixtureTrace.observeCandidateIdentity(record),
      fetcher: (input: RequestInfo | URL, init?: RequestInit) =>
        fixedPlacesFetcher(this.fixtureTrace, this.fixtureNow, (query) =>
          this.fixtureSearchQueries.push(query),
        )(input, init),
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
