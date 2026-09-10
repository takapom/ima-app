import type { ModelGetPlaceDetailsInput } from '@ima/core';
import type {
  RuntimeGateModelCallOptions,
  RuntimeGateModelStreamPart,
} from '../runtime-gate/runtime-gate-provider';
import { finalParts, toolParts } from './model-eval-context-output';
import { modelContextIn } from './model-eval-context-values';

/** Maps the canonical dataset alias to the opaque reference minted by SavedReferenceDO. */
export type ModelEvalFixtureSavedReference = {
  readonly semanticRef: string;
  readonly runtimeRef: string;
  readonly provider: string;
  readonly recordRef: string;
};

type SavedReferenceDetails = {
  readonly candidateId: string;
  readonly evidenceIds: readonly string[];
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const array = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? (value as readonly unknown[]) : [];

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

const savedReferenceIdsIn = (prompt: RuntimeGateModelCallOptions['prompt']): readonly string[] =>
  array(modelContextIn(prompt)?.savedReferences).flatMap((value) => {
    if (!record(value) || typeof value.savedPlaceRef !== 'string') return [];
    return [value.savedPlaceRef];
  });

const observationIdsFor = (
  value: unknown,
  candidateId: string,
  field: string,
): readonly string[] => {
  if (!record(value) || value.status !== 'known') return [];
  return array(value.observations).flatMap((observation) => {
    if (
      !record(observation) ||
      observation.candidateId !== candidateId ||
      observation.field !== field ||
      typeof observation.observationId !== 'string'
    ) {
      return [];
    }
    return [observation.observationId];
  });
};

const detailsFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  runtimeRef: string,
): SavedReferenceDetails | undefined => {
  let found: SavedReferenceDetails | undefined;
  for (const message of prompt) {
    if (!record(message) || message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        !record(part) ||
        part.type !== 'tool-result' ||
        part.toolName !== 'get_place_details' ||
        !record(part.output) ||
        part.output.type !== 'json'
      ) {
        continue;
      }
      const output = part.output.value;
      if (!record(output) || (output.status !== 'ok' && output.status !== 'partial')) continue;
      const items = record(output.data) ? output.data.items : undefined;
      for (const item of array(items)) {
        if (
          !record(item) ||
          item.savedPlaceRef !== runtimeRef ||
          typeof item.candidateId !== 'string'
        ) {
          continue;
        }
        const fields = item.fields;
        const identity = observationIdsFor(
          record(fields) ? fields.identity : undefined,
          item.candidateId,
          'identity',
        );
        const openingHours = observationIdsFor(
          record(fields) ? fields.opening_hours : undefined,
          item.candidateId,
          'opening_hours',
        );
        if (identity.length === 0 || openingHours.length === 0) continue;
        found = {
          candidateId: item.candidateId,
          evidenceIds: unique([...identity, ...openingHours]),
        };
        return found;
      }
    }
  }
  return found;
};

/** Emits one formal saved-reference Details action, then a grounded or safe failure message. */
export const savedReferencePartsFor = (input: {
  readonly prompt: RuntimeGateModelCallOptions['prompt'];
  readonly currentCall: number;
  readonly savedReference: ModelEvalFixtureSavedReference | undefined;
  readonly step: (name: 'get_place_details' | 'final_message') => void;
  readonly requested: (semanticRef: string) => void;
  readonly resolved: (
    semanticRef: string,
    candidateId: string,
    evidenceIds: readonly string[],
  ) => void;
}): readonly RuntimeGateModelStreamPart[] => {
  const binding = input.savedReference;
  if (binding === undefined) throw new Error('M25_FIXTURE_SAVED_REFERENCE_BINDING_MISSING');
  const formalRefs = savedReferenceIdsIn(input.prompt);
  if (formalRefs.length !== 1 || formalRefs[0] !== binding.runtimeRef) {
    throw new Error('M25_FIXTURE_SAVED_REFERENCE_CONTEXT_MISSING');
  }
  if (input.currentCall === 0) {
    input.requested(binding.semanticRef);
    input.step('get_place_details');
    const details: ModelGetPlaceDetailsInput = {
      requests: [{ savedPlaceRef: binding.runtimeRef, fields: ['identity', 'opening_hours'] }],
      freshness: 'refresh',
    };
    return toolParts(input.currentCall, 'get_place_details', details);
  }
  const details = detailsFor(input.prompt, binding.runtimeRef);
  input.step('final_message');
  if (details === undefined) {
    return finalParts('保存した店を確認できませんでした。', [], 'conversational');
  }
  input.resolved(binding.semanticRef, details.candidateId, details.evidenceIds);
  return finalParts('保存した店の営業時間を確認しました。', details.evidenceIds);
};
