import type { GetPlaceDetailsInput, SearchPlacesInput } from '@worker/application/ports/operations';
import type { RespondInput } from '@worker/application/ports/model';
import type {
  RuntimeGateModelCallOptions,
  RuntimeGateModelStreamPart,
} from '../support/runtime-model-fixture';
import {
  candidateIdsIn,
  knownFieldsFor,
  modelPreferenceBudgetIn,
  observationFieldsFor,
  type ProjectedObservation,
} from './model-eval-context-values';

export const FIXTURE_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

const toolFinish = { unified: 'tool-calls', raw: 'tool-calls' } as const;

/** What the fixture model had in view for one candidate when it responded. */
export type ModelEvalFixtureEvidenceSnapshot = {
  readonly candidateId: string;
  readonly knownFields: readonly string[];
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
  input: SearchPlacesInput | GetPlaceDetailsInput | RespondInput,
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

/** A question or an answer committed through respond, the only way a turn ends. */
export const messageParts = (
  call: number,
  kind: 'ask' | 'answer',
  message: string,
): RuntimeGateModelStreamPart[] => toolParts(call, 'respond', { kind, message });

export const submitInputFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  candidateOrder = candidateIdsIn(prompt),
): RespondInput => {
  const selections = candidateOrder
    .filter((candidateId) => knownFieldsFor(prompt, candidateId).includes('identity'))
    .map((candidateId) => ({ candidateId }))
    .slice(0, 3);
  const fallback = selections[0];
  if (fallback === undefined) throw new Error('M25_FIXTURE_CONTEXT_MISSING');
  const selectionFor = (candidate: (typeof selections)[number]) => ({
    candidateId: candidate.candidateId,
    why: '固定fixtureの公開根拠を確認しました。',
  });
  const alternatives = selections.slice(1).map((candidate) => ({
    ...selectionFor(candidate),
    diff: '別候補として比較できます。',
  }));
  return {
    kind: 'propose',
    message: ['固定fixtureの候補を提示します。'],
    hero: selectionFor(fallback),
    alts: alternatives,
  };
};

export const evidenceSnapshotFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  candidateId: string,
): ModelEvalFixtureEvidenceSnapshot => ({
  candidateId,
  knownFields: [...knownFieldsFor(prompt, candidateId)],
  modelBudget: modelPreferenceBudgetIn(prompt),
  observations: observationFieldsFor(prompt, candidateId),
});
