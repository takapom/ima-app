import type {
  RuntimeGateModel,
  RuntimeGateModelCallOptions,
} from '../support/runtime-model-fixture';
import {
  MODEL_EVAL_PRIVATE_UPSTREAM_BODY_SENTINEL,
  type ModelEvalPlaceDisplayNameMode,
  type ModelEvalPlacePayloadMode,
} from './model-eval-place-fixture';
import type { LiveTraceRecorder } from '../../tooling/model-eval/live';
import {
  evidenceSnapshotFor,
  FIXTURE_USAGE,
  messageParts,
  streamOf,
  submitInputFor,
  toolParts,
  type ModelEvalFixtureEvidenceSnapshot,
} from './model-eval-context-output';
import {
  candidateOrderIn,
  candidateIdsIn,
  knownFieldsFor,
  modelLocationIn,
  modelLocationProjectionHasCoordinates,
  modelPreferenceBudgetIn,
  modelPromptContains,
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
import { repairPartsFor } from './model-eval-repair';
import {
  promptInjectionAuditFor,
  type ModelEvalPromptInjectionAudit,
} from './model-eval-prompt-injection';
import { safeModelPartsFor } from './model-eval-safe-model';
import { specificPlacePartsFor } from './model-eval-specific-place';

export type ModelEvalFixturePhase = 'cards' | 'message';
export type ModelEvalFixtureLocationProbe = 'clarify' | 'current-location';
export type ModelEvalFixtureDisplayNamePolicy = 'visible' | 'withheld';
/** Tool steps the fixture took; respond is qualified by the kind it committed. */
export type ModelEvalFixtureStep =
  'search_places' | 'get_place_details' | 'respond:ask' | 'respond:answer' | 'respond:propose';
export type ModelEvalFixtureProfile =
  | 'reason'
  | 'continuity'
  | 'compare'
  | 'specific-place'
  | 'decide-action'
  | 'clarify-ambiguity'
  | 'candidate-failure'
  | 'prompt-injection'
  | 'gps-refusal'
  | 'repair'
  | ModelEvalConditionFixtureProfile;
export type ModelEvalFixtureOptions = {
  readonly placeDisplayNameMode?: ModelEvalPlaceDisplayNameMode;
  readonly placePayloadMode?: ModelEvalPlacePayloadMode;
  readonly displayNamePolicy?: ModelEvalFixtureDisplayNamePolicy;
  readonly threadCreatedAt?: string;
};

export const fixtureModel = (
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
  privateUpstreamBodyExposed: () => void,
  promptInjectionAudit: (audit: ModelEvalPromptInjectionAudit) => void,
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
      if (modelPromptContains(prompt, MODEL_EVAL_PRIVATE_UPSTREAM_BODY_SENTINEL)) {
        privateUpstreamBodyExposed();
      }
      if (profile() === 'prompt-injection') promptInjectionAudit(promptInjectionAuditFor(prompt));
      assertConditionProjection(profile(), modelPreferenceBudgetIn(prompt));
      const currentCall = call;
      call += 1;
      const safeParts = safeModelPartsFor({
        phase: currentPhase,
        profile: profile(),
        currentCall,
        prompt,
        locationProbe: locationProbe(),
        step,
      });
      if (safeParts !== undefined) {
        return Promise.resolve({ stream: streamOf(safeParts) });
      }
      const offered = (options.tools ?? []).map((tool) => tool.name);
      const finalResponse = offered.length === 1 && offered[0] === 'respond';
      const shouldRefreshMessage = currentPhase === 'message' && currentCall === 0;
      if (currentPhase === 'message' && profile() === 'clarify-ambiguity') {
        step('respond:ask');
        return Promise.resolve({
          stream: streamOf(messageParts(currentCall, 'ask', 'どの候補を指していますか？')),
        });
      }
      if (currentPhase === 'message' && profile() === 'specific-place') {
        return Promise.resolve({
          stream: specificPlacePartsFor({
            prompt,
            currentCall,
            step,
            detailsRequest,
            finalEvidence,
          }),
        });
      }
      if (currentPhase === 'message' && profile() === 'repair') {
        return Promise.resolve({
          stream: repairPartsFor({
            prompt,
            currentCall,
            step,
            detailsRequest,
            finalEvidence,
          }),
        });
      }
      if (!shouldRefreshMessage && (currentPhase === 'message' || finalResponse)) {
        step('respond:answer');
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
          .map((candidateId) => ({ candidateId, known: knownFieldsFor(prompt, candidateId) }))
          .find((item) => item.known.length > 0);
        const requestedCandidateId =
          currentPhase === 'message' && profile() === 'decide-action'
            ? selectedCandidateId
            : (() => {
                const userText = modelUserTextIn(prompt);
                const requestedIndex = userText.includes('2つ目') ? 1 : 0;
                return candidates[requestedIndex] ?? candidates[0];
              })();
        const requestedCandidate = candidates
          .map((candidateId) => ({ candidateId, known: knownFieldsFor(prompt, candidateId) }))
          .find((item) => item.candidateId === requestedCandidateId && item.known.length > 0);
        const selectedCandidate =
          currentPhase === 'message' ? requestedCandidate : (requestedCandidate ?? candidate);
        if (selectedCandidate === undefined) throw new Error('M25_FIXTURE_CONTEXT_MISSING');
        if (currentPhase === 'message' && profile() === 'compare') {
          const compared = candidates
            .slice(0, 2)
            .filter((candidateId) => knownFieldsFor(prompt, candidateId).length > 0);
          if (compared.length < 2) throw new Error('M25_FIXTURE_COMPARE_CONTEXT_MISSING');
          compared.forEach((candidateId) =>
            finalEvidence(evidenceSnapshotFor(prompt, candidateId)),
          );
          return Promise.resolve({
            stream: streamOf(
              messageParts(currentCall, 'answer', '青葉カフェと川辺食堂を比較しました。'),
            ),
          });
        }
        const candidateId = selectedCandidate.candidateId;
        finalEvidence(evidenceSnapshotFor(prompt, candidateId));
        return Promise.resolve({
          stream: streamOf(
            messageParts(currentCall, 'answer', `${candidateId}の公開根拠を確認しました。`),
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
      step('respond:propose');
      const candidates = candidateIdsIn(prompt).slice(0, candidateLimitFor(profile()));
      for (const candidateId of candidates) {
        if (knownFieldsFor(prompt, candidateId).length === 0) continue;
        finalEvidence(evidenceSnapshotFor(prompt, candidateId));
      }
      return Promise.resolve({
        stream: streamOf(
          toolParts(
            currentCall,
            'respond',
            submitInputFor(
              prompt,
              profile() === 'decide-action' || profile() === 'specific-place'
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
