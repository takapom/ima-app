import type { RuntimeGateModelCallOptions } from '../runtime-gate/runtime-gate-provider';

export type ModelContextEnvelope = {
  readonly kind: 'ima_turn_context';
  readonly originalUserText?: unknown;
  readonly context?: {
    readonly userText?: unknown;
    readonly cardSet?: unknown;
    readonly evidence?: unknown;
  };
};

export type ProjectedPromptValues = {
  readonly candidateIds: Set<string>;
  readonly observationIdsByCandidate: Map<string, Set<string>>;
  readonly observationsByCandidate: Map<string, Map<string, string>>;
};

export type ProjectedObservation = {
  readonly candidateId: string;
  readonly field: string;
  readonly observationId: string;
};

const isCandidateId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const unknownArray = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? (value as readonly unknown[]) : undefined;

const structuredPrompt = (prompt: RuntimeGateModelCallOptions['prompt']): unknown => {
  try {
    return JSON.parse(JSON.stringify(prompt));
  } catch {
    return null;
  }
};

/** Reads the structured turn envelope and ignores the original user text. */
const modelEnvelopeIn = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): ModelContextEnvelope | undefined => {
  const messages = unknownArray(structuredPrompt(prompt));
  if (messages === undefined) return undefined;
  for (const message of messages) {
    if (!record(message) || message.role !== 'user' || !('content' in message)) continue;
    const content = message.content;
    const contentParts = unknownArray(content);
    const encodedContents =
      typeof content === 'string'
        ? [content]
        : contentParts === undefined
          ? []
          : contentParts.flatMap((part) => {
              if (!record(part) || typeof part.text !== 'string') return [];
              return [part.text];
            });
    for (const encodedContent of encodedContents) {
      try {
        const envelope: unknown = JSON.parse(encodedContent);
        if (typeof envelope !== 'object' || envelope === null) continue;
        if (!('kind' in envelope) || envelope.kind !== 'ima_turn_context') continue;
        if (!('context' in envelope) || typeof envelope.context !== 'object') continue;
        return envelope as ModelContextEnvelope;
      } catch {
        // Other user parts are not context envelopes.
      }
    }
  }
  return undefined;
};

export const modelContextIn = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): ModelContextEnvelope['context'] | undefined => modelEnvelopeIn(prompt)?.context;

/** The turn text is used only for semantic selection; IDs come from formal card context. */
export const modelUserTextIn = (prompt: RuntimeGateModelCallOptions['prompt']): string => {
  const text = modelEnvelopeIn(prompt)?.originalUserText;
  return typeof text === 'string' ? text : '';
};

/** Collects IDs and evidence only from projected context and structured tool output. */
export const collectProjectedPromptValues = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): ProjectedPromptValues => {
  const values: ProjectedPromptValues = {
    candidateIds: new Set<string>(),
    observationIdsByCandidate: new Map<string, Set<string>>(),
    observationsByCandidate: new Map<string, Map<string, string>>(),
  };
  const visit = (value: unknown, parentKey?: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, parentKey));
      return;
    }
    if (typeof value !== 'object' || value === null) {
      if (
        typeof value === 'string' &&
        (parentKey === 'content' || parentKey === 'input' || parentKey === 'output') &&
        /^[\[{]/u.test(value)
      ) {
        try {
          visit(JSON.parse(value), parentKey);
        } catch {
          // A partial tool payload can be invalid while a model step is running.
        }
      }
      return;
    }
    const record = value as Record<string, unknown>;
    const candidateId = record.candidateId;
    const structuredCandidate =
      isCandidateId(candidateId) &&
      (parentKey === 'candidates' ||
        parentKey === 'entries' ||
        parentKey === 'evidence' ||
        parentKey === 'items' ||
        parentKey === 'requests' ||
        typeof record.observationId === 'string' ||
        typeof record.displayName === 'string');
    if (structuredCandidate) {
      values.candidateIds.add(candidateId);
      if (typeof record.observationId === 'string') {
        const observationIds =
          values.observationIdsByCandidate.get(candidateId) ?? new Set<string>();
        observationIds.add(record.observationId);
        values.observationIdsByCandidate.set(candidateId, observationIds);
        if (typeof record.field === 'string') {
          const observations =
            values.observationsByCandidate.get(candidateId) ?? new Map<string, string>();
          observations.set(record.field, record.observationId);
          values.observationsByCandidate.set(candidateId, observations);
        }
      }
    }
    const order = record.candidateOrder;
    if (Array.isArray(order))
      order.filter(isCandidateId).forEach((id) => values.candidateIds.add(id));
    Object.entries(record).forEach(([key, item]) => visit(item, key));
  };

  visit(modelContextIn(prompt));
  const messages = unknownArray(structuredPrompt(prompt));
  if (messages !== undefined) {
    for (const message of messages) {
      if (!record(message) || !('role' in message)) continue;
      if (message.role !== 'assistant' && message.role !== 'tool') continue;
      if ('content' in message) visit(message.content, 'content');
    }
  }
  return values;
};

const cardSetCandidateOrder = (
  context: ModelContextEnvelope['context'] | undefined,
): readonly string[] => {
  const cardSet = context?.cardSet;
  if (!record(cardSet) || !Array.isArray(cardSet.entries)) return [];
  return cardSet.entries.flatMap((entry) =>
    record(entry) && isCandidateId(entry.candidateId) ? [entry.candidateId] : [],
  );
};

/** Returns the persisted card order before any evidence/tool traversal order. */
export const candidateOrderIn = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): readonly string[] => cardSetCandidateOrder(modelContextIn(prompt));

/** Returns only field/observation IDs projected for one candidate. */
export const observationFieldsFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  candidateId: string,
): readonly ProjectedObservation[] => {
  const observations =
    collectProjectedPromptValues(prompt).observationsByCandidate.get(candidateId);
  if (observations === undefined) return [];
  return [...observations].map(([field, observationId]) => ({
    candidateId,
    field,
    observationId,
  }));
};

/** Reads candidate IDs only from projected card/evidence or tool structures. */
export const candidateIdsIn = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): readonly string[] => {
  const ordered = candidateOrderIn(prompt);
  const observed = [...collectProjectedPromptValues(prompt).candidateIds];
  return [...ordered, ...observed.filter((candidateId) => !ordered.includes(candidateId))];
};

export const evidenceFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  candidateId: string,
): readonly string[] => {
  const values = collectProjectedPromptValues(prompt);
  const byField = values.observationsByCandidate.get(candidateId);
  if (byField !== undefined) {
    const preferred = ['identity', 'opening_hours', 'price'];
    const preferredIds = preferred.flatMap((field) => {
      const observationId = byField.get(field);
      return observationId === undefined ? [] : [observationId];
    });
    const remainingIds = [...(values.observationIdsByCandidate.get(candidateId) ?? [])].filter(
      (observationId) => !preferredIds.includes(observationId),
    );
    return (preferredIds.length > 0 ? preferredIds : remainingIds).slice(0, 4);
  }
  return [...(values.observationIdsByCandidate.get(candidateId) ?? [])].slice(0, 4);
};
