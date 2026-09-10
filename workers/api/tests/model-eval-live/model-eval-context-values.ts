import type { RuntimeGateModelCallOptions } from '../runtime-gate/runtime-gate-provider';

export type ModelContextEnvelope = {
  readonly kind: 'ima_turn_context';
  readonly originalUserText?: unknown;
  readonly context?: {
    readonly userText?: unknown;
    readonly location?: unknown;
    readonly preferences?: unknown;
    readonly cardSet?: unknown;
    readonly evidence?: unknown;
    readonly savedReferences?: unknown;
  };
};

export type ProjectedModelLocation = {
  readonly status: string;
  readonly areaDescription: string | null;
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

const valueContainsText = (value: unknown, marker: string): boolean => {
  if (typeof value === 'string') return value.includes(marker);
  if (Array.isArray(value)) return value.some((item) => valueContainsText(item, marker));
  if (!record(value)) return false;
  return Object.values(value).some((item) => valueContainsText(item, marker));
};

/** Reads the structured turn envelope and ignores the original user text. */
const modelEnvelopeIn = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): ModelContextEnvelope | undefined => {
  for (const message of prompt) {
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

/** Reads budget only from the formal model projection, never from user text. */
export const modelPreferenceBudgetIn = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): string | null => {
  const preferences = modelContextIn(prompt)?.preferences;
  if (!record(preferences)) return null;
  const budget = preferences.budget;
  return budget === null || typeof budget === 'string' ? budget : null;
};

/** Reads only the model-visible location projection; raw coordinates are never returned. */
export const modelLocationIn = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): ProjectedModelLocation | undefined => {
  const location = modelContextIn(prompt)?.location;
  if (typeof location !== 'object' || location === null) return undefined;
  const value = location as Record<string, unknown>;
  if (typeof value.status !== 'string') return undefined;
  if (!('areaDescription' in value)) return undefined;
  if (value.areaDescription !== null && typeof value.areaDescription !== 'string') {
    return undefined;
  }
  return {
    status: value.status,
    areaDescription: value.areaDescription,
  };
};

/** Returns only whether the formal model projection contains a coordinate field. */
export const modelLocationProjectionHasCoordinates = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): boolean => {
  const location = modelContextIn(prompt)?.location;
  if (!record(location)) return false;
  return ['lat', 'lng', 'accuracyMeters', 'capturedAt'].some((key) => key in location);
};

/** Reads only a fixed provider error code from tool output; prompt text is never retained. */
export const modelToolErrorCodesIn = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): readonly string[] => {
  const codes = new Set<string>();
  prompt.forEach((message) => {
    if (!record(message) || message.role !== 'tool') return;
    const parts = unknownArray(message.content);
    if (parts === undefined) return;
    parts.forEach((part) => {
      if (!record(part) || part.type !== 'tool-result' || !record(part.output)) return;
      const outputValue = part.output.value;
      if (!record(outputValue) || !record(outputValue.error)) return;
      if (typeof outputValue.error.code === 'string') codes.add(outputValue.error.code);
    });
  });
  return [...codes];
};

export const modelToolErrorCodeIn = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  code: string,
): boolean => modelToolErrorCodesIn(prompt).includes(code);

export type ProjectedSearchResult =
  | {
      readonly kind: 'success';
      readonly status: 'ok' | 'partial';
      readonly candidateCount: number;
    }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'unknown' };

/** Reads search status only from a structured tool result; absent data stays unknown. */
export const modelSearchResultIn = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): ProjectedSearchResult => {
  for (const message of prompt) {
    if (!record(message) || message.role !== 'tool') continue;
    const parts = unknownArray(message.content);
    if (parts === undefined) continue;
    for (const part of parts) {
      if (
        !record(part) ||
        part.type !== 'tool-result' ||
        part.toolName !== 'search_places' ||
        !record(part.output)
      )
        continue;
      const outputValue = part.output.value;
      if (!record(outputValue)) continue;
      if (outputValue.status === 'error') {
        const error = outputValue.error;
        const code = record(error) && typeof error.code === 'string' ? error.code : null;
        if (code !== null) return { kind: 'error', code };
        continue;
      }
      if (outputValue.status !== 'ok' && outputValue.status !== 'partial') continue;
      const data = outputValue.data;
      if (!record(data) || !Array.isArray(data.candidates)) continue;
      return {
        kind: 'success',
        status: outputValue.status,
        candidateCount: data.candidates.length,
      };
    }
  }
  return { kind: 'unknown' };
};

/** Audits one marker without retaining the model prompt or provider body. */
export const modelPromptContains = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  marker: string,
): boolean => prompt.some((message) => valueContainsText(message, marker));

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
  for (const message of prompt) {
    if (!record(message) || !('role' in message)) continue;
    if (message.role !== 'assistant' && message.role !== 'tool') continue;
    if ('content' in message) visit(message.content, 'content');
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

/** Reads selection only from the projected card set, never from user text. */
export const selectedCandidateIdIn = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): string | null | undefined => {
  const cardSet = modelContextIn(prompt)?.cardSet;
  if (!record(cardSet) || !('selectedCandidateId' in cardSet)) return undefined;
  const selected = cardSet.selectedCandidateId;
  return selected === null || typeof selected === 'string' ? selected : undefined;
};

export type ModelCandidateMentionResolution =
  | { readonly ok: true; readonly candidateId: string }
  | {
      readonly ok: false;
      readonly reason:
        'card_set_missing' | 'display_name_withheld' | 'no_match' | 'multiple_matches';
    };

/** Resolves a user mention against the model-visible card names without order fallback. */
export const candidateMentionedIn = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): ModelCandidateMentionResolution => {
  const cardSet = modelContextIn(prompt)?.cardSet;
  if (!record(cardSet) || !Array.isArray(cardSet.entries) || !Array.isArray(cardSet.candidates)) {
    return { ok: false, reason: 'card_set_missing' };
  }
  const candidates = new Map<string, string>();
  for (const candidate of cardSet.candidates) {
    if (!record(candidate) || !isCandidateId(candidate.candidateId)) continue;
    if (typeof candidate.displayName !== 'string') continue;
    candidates.set(candidate.candidateId, candidate.displayName);
  }
  const presented = cardSet.entries.flatMap((entry) => {
    if (!record(entry) || !isCandidateId(entry.candidateId)) return [];
    const displayName = candidates.get(entry.candidateId);
    return displayName === undefined ? [] : [{ candidateId: entry.candidateId, displayName }];
  });
  if (presented.length === 0) return { ok: false, reason: 'card_set_missing' };
  const userText = modelUserTextIn(prompt);
  const matches = presented.filter(
    ({ displayName }) => displayName !== '[withheld]' && userText.includes(displayName),
  );
  const match = matches[0];
  if (matches.length === 1 && match !== undefined)
    return { ok: true, candidateId: match.candidateId };
  if (matches.length > 1) return { ok: false, reason: 'multiple_matches' };
  return {
    ok: false,
    reason: presented.some(({ displayName }) => displayName === '[withheld]')
      ? 'display_name_withheld'
      : 'no_match',
  };
};

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
