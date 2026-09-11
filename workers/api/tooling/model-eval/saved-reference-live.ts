/** Owner-DO output used to join an opaque request ref back to a fixture alias. */
export type LiveSavedReferenceBinding = {
  readonly semanticRef: string;
  readonly runtimeRef: string;
  readonly provider: string;
  readonly recordRef: string;
};

export type LiveSavedReferenceObservation = LiveSavedReferenceBinding & {
  readonly candidateId: string;
};

type RecordValue = Record<string, unknown>;

const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const array = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? (value as readonly unknown[]) : [];

const knownFieldWithObservation = (
  fields: RecordValue,
  fieldName: string,
  binding: LiveSavedReferenceBinding,
  candidateId: string,
): boolean => {
  const field = fields[fieldName];
  if (!record(field) || field.status !== 'known') return false;
  const observations = array(field.observations);
  return (
    observations.length > 0 &&
    observations.every((observation) => {
      if (
        !record(observation) ||
        typeof observation.observationId !== 'string' ||
        observation.observationId.length === 0 ||
        observation.candidateId !== candidateId ||
        observation.field !== fieldName
      ) {
        return false;
      }
      const sources = array(observation.sources);
      // The model projection deliberately omits recordRef. The owner-bound
      // opaque ref echo is the record binding; source provider still must
      // agree with that binding before a semantic alias is resolved.
      return (
        sources.length > 0 &&
        sources.every((source) => record(source) && source.provider === binding.provider)
      );
    })
  );
};

/**
 * Resolves saved aliases only from structured Details tool results already
 * present in the model prompt. User text and arbitrary JSON text are ignored.
 */
export const savedReferenceObservationsFromPrompt = (
  prompt: unknown,
  bindings: readonly LiveSavedReferenceBinding[],
): readonly LiveSavedReferenceObservation[] => {
  const byRuntimeRef = new Map(bindings.map((binding) => [binding.runtimeRef, binding]));
  const resolved = new Map<string, LiveSavedReferenceObservation>();
  for (const message of array(prompt)) {
    if (!record(message) || message.role !== 'tool') continue;
    for (const part of array(message.content)) {
      if (
        !record(part) ||
        part.type !== 'tool-result' ||
        part.toolName !== 'get_place_details' ||
        !record(part.output) ||
        part.output.type !== 'json' ||
        !record(part.output.value) ||
        (part.output.value.status !== 'ok' && part.output.value.status !== 'partial') ||
        !record(part.output.value.data)
      ) {
        continue;
      }
      for (const item of array(part.output.value.data.items)) {
        if (
          !record(item) ||
          typeof item.savedPlaceRef !== 'string' ||
          typeof item.candidateId !== 'string'
        ) {
          continue;
        }
        const binding = byRuntimeRef.get(item.savedPlaceRef);
        if (
          binding === undefined ||
          !record(item.fields) ||
          !knownFieldWithObservation(item.fields, 'identity', binding, item.candidateId) ||
          !knownFieldWithObservation(item.fields, 'opening_hours', binding, item.candidateId)
        ) {
          continue;
        }
        const observation = { ...binding, candidateId: item.candidateId };
        resolved.set(`${binding.semanticRef}:${item.candidateId}`, observation);
      }
    }
  }
  return [...resolved.values()];
};
