import type {
  RuntimeGateModelCallOptions,
  RuntimeGateModelStreamPart,
} from '../support/runtime-model-fixture';
import {
  evidenceSnapshotFor,
  messageParts,
  streamOf,
  toolParts,
  type ModelEvalFixtureEvidenceSnapshot,
} from './model-eval-context-output';
import { candidateMentionedIn, knownFieldsFor } from './model-eval-context-values';

/** Produces only the specific-place fixture's details refresh or clarification turn. */
export const specificPlacePartsFor = (input: {
  readonly prompt: RuntimeGateModelCallOptions['prompt'];
  readonly currentCall: number;
  readonly step: (name: 'get_place_details' | 'respond:ask' | 'respond:answer') => void;
  readonly detailsRequest: (candidateIds: readonly string[]) => void;
  readonly finalEvidence: (snapshot: ModelEvalFixtureEvidenceSnapshot) => void;
}): ReadableStream<RuntimeGateModelStreamPart> => {
  const resolution = candidateMentionedIn(input.prompt);
  if (!resolution.ok) {
    input.step('respond:ask');
    return streamOf(
      messageParts(
        input.currentCall,
        'ask',
        'どの候補を指しているか特定できないため、候補を指定してください。',
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
  if (!knownFieldsFor(input.prompt, resolution.candidateId).includes('opening_hours')) {
    throw new Error('M25_FIXTURE_SPECIFIC_PLACE_EVIDENCE_MISSING');
  }
  input.step('respond:answer');
  input.finalEvidence(evidenceSnapshotFor(input.prompt, resolution.candidateId));
  return streamOf(messageParts(input.currentCall, 'answer', '営業時間を確認しました。'));
};
