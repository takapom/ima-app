import type { GetPlaceDetailsInput, SearchPlacesInput } from '@worker/application/ports/operations';
import type { SubmitCardsInput } from '@worker/application/ports/model';
import type {
  RuntimeGateModelCallOptions,
  RuntimeGateModelStreamPart,
} from '../support/runtime-model-fixture';
import {
  candidateIdsIn,
  evidenceFor,
  modelPreferenceBudgetIn,
  observationFieldsFor,
  type ProjectedObservation,
} from './model-eval-context-values';

export const FIXTURE_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

const toolFinish = { unified: 'tool-calls', raw: 'tool-calls' } as const;
const stopFinish = { unified: 'stop', raw: 'stop' } as const;

export type ModelEvalFixtureEvidenceSnapshot = {
  readonly candidateId: string;
  readonly evidenceIds: readonly string[];
  readonly modelBudget: string | null;
  readonly observations: readonly ProjectedObservation[];
};

export const streamOf = (
  parts: readonly RuntimeGateModelStreamPart[],
): ReadableStream<RuntimeGateModelStreamPart> =>
  new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });

export const toolParts = (
  call: number,
  toolName: string,
  input: SearchPlacesInput | GetPlaceDetailsInput | SubmitCardsInput,
): RuntimeGateModelStreamPart[] => {
  const id = `model-eval-fixture-${toolName}-${call}`;
  const encoded = JSON.stringify({ input });
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: encoded },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: encoded },
    { type: 'finish', usage: FIXTURE_USAGE, finishReason: toolFinish },
  ];
};

export const finalParts = (
  text: string,
  evidenceIds: readonly string[],
  basis: 'grounded' | 'conversational' = 'grounded',
): RuntimeGateModelStreamPart[] => {
  const encoded = JSON.stringify({
    kind: 'final_message',
    message: { text, evidenceIds, basis },
  });
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'model-eval-fixture-final' },
    { type: 'text-delta', id: 'model-eval-fixture-final', delta: encoded },
    { type: 'text-end', id: 'model-eval-fixture-final' },
    { type: 'finish', usage: FIXTURE_USAGE, finishReason: stopFinish },
  ];
};

export const submitInputFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  candidateOrder = candidateIdsIn(prompt),
): SubmitCardsInput => {
  const selections = candidateOrder
    .map((candidateId) => ({ candidateId, evidenceIds: evidenceFor(prompt, candidateId) }))
    .filter((candidate) => candidate.evidenceIds.length > 0)
    .slice(0, 3);
  const fallback = selections[0];
  if (fallback === undefined) throw new Error('M25_FIXTURE_CONTEXT_MISSING');
  const selectionFor = (candidate: (typeof selections)[number]) => ({
    candidateId: candidate.candidateId,
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

export const evidenceSnapshotFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  candidateId: string,
): ModelEvalFixtureEvidenceSnapshot => ({
  candidateId,
  evidenceIds: [...evidenceFor(prompt, candidateId)],
  modelBudget: modelPreferenceBudgetIn(prompt),
  observations: observationFieldsFor(prompt, candidateId),
});
