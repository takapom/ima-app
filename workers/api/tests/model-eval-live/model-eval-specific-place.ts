import type {
  RuntimeGateModelCallOptions,
  RuntimeGateModelStreamPart,
} from '../runtime-gate/runtime-gate-provider';
import {
  evidenceSnapshotFor,
  finalParts,
  streamOf,
  toolParts,
  type ModelEvalFixtureEvidenceSnapshot,
} from './model-eval-context-output';
import { candidateMentionedIn, evidenceFor } from './model-eval-context-values';

/** Produces only the specific-place fixture's details refresh or clarification turn. */
export const specificPlacePartsFor = (input: {
  readonly prompt: RuntimeGateModelCallOptions['prompt'];
  readonly currentCall: number;
  readonly step: (name: 'get_place_details' | 'final_message') => void;
  readonly detailsRequest: (candidateIds: readonly string[]) => void;
  readonly finalEvidence: (snapshot: ModelEvalFixtureEvidenceSnapshot) => void;
}): ReadableStream<RuntimeGateModelStreamPart> => {
  const resolution = candidateMentionedIn(input.prompt);
  if (!resolution.ok) {
    input.step('final_message');
    return streamOf(
      finalParts(
        'どの候補を指しているか特定できないため、候補を指定してください。',
        [],
        'conversational',
      ),
    );
  }
  if (input.currentCall === 0) {
    input.step('get_place_details');
    input.detailsRequest([resolution.candidateId]);
    return streamOf(
      toolParts(input.currentCall, 'get_place_details', {
        requests: [
          {
            candidateId: resolution.candidateId,
            fields: ['identity', 'opening_hours', 'price'],
          },
        ],
        freshness: 'refresh',
      }),
    );
  }
  const evidenceIds = evidenceFor(input.prompt, resolution.candidateId);
  if (evidenceIds.length === 0) throw new Error('M25_FIXTURE_SPECIFIC_PLACE_EVIDENCE_MISSING');
  input.step('final_message');
  input.finalEvidence(evidenceSnapshotFor(input.prompt, resolution.candidateId));
  return streamOf(finalParts('営業時間を確認しました。', evidenceIds));
};
