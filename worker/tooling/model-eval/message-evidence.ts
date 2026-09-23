import type { AssistantMessageResponse } from '@ima/contracts';
import type {
  CandidateIdentityMapping,
  CandidateIdentityMappingFailure,
  EvidenceReferenceCapture,
  RuntimeEvidenceReference,
} from './candidate-mapping';
import type { CandidateSelection, EvaluationCase } from './types';

type RecordValue = Record<string, unknown>;

const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const array = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? (value as readonly unknown[]) : [];

const textParts = (value: unknown): readonly string[] => {
  if (typeof value === 'string') return [value];
  return array(value).flatMap((part) => {
    if (!record(part) || part.type !== 'text' || typeof part.text !== 'string') return [];
    return [part.text];
  });
};

const contextEvidenceIn = (encoded: string): readonly unknown[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return [];
  }
  if (!record(parsed) || parsed.kind !== 'ima_turn_context' || !record(parsed.context)) return [];
  return array(parsed.context.evidence).filter(
    (entry) => record(entry) && entry.status === 'known',
  );
};

const observeStructuredFieldResults = (value: unknown, capture: EvidenceReferenceCapture): void => {
  if (!record(value) || (value.status !== 'ok' && value.status !== 'partial')) return;
  const data = value.data;
  if (!record(data)) return;
  for (const collection of [data.items, data.candidates]) {
    for (const item of array(collection)) {
      if (!record(item) || !record(item.fields)) continue;
      const candidateId = item.candidateId;
      for (const [fieldKey, field] of Object.entries(item.fields)) {
        if (!record(field) || field.status !== 'known') continue;
        const expectedField = fieldKey === 'openingHours' ? 'opening_hours' : fieldKey;
        const observations = field.observations;
        if (!Array.isArray(observations)) {
          capture.observe(undefined);
          continue;
        }
        for (const observation of observations) {
          if (
            !record(observation) ||
            observation.candidateId !== candidateId ||
            observation.field !== expectedField
          ) {
            capture.observe(undefined);
            continue;
          }
          capture.observe(observation);
        }
      }
    }
  }
};

/**
 * Captures evidence identities only from the formal context envelope and JSON
 * tool results. The original user text and arbitrary text-shaped JSON are not
 * traversed as evidence.
 */
export const observeStructuredEvidenceReferences = (
  prompt: unknown,
  capture: EvidenceReferenceCapture,
): void => {
  for (const message of array(prompt)) {
    if (!record(message)) continue;
    if (message.role === 'user') {
      for (const encoded of textParts(message.content)) {
        for (const evidence of contextEvidenceIn(encoded)) capture.observe(evidence);
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    for (const part of array(message.content)) {
      if (
        !record(part) ||
        part.type !== 'tool-result' ||
        (part.toolName !== 'search_places' && part.toolName !== 'get_place_details') ||
        !record(part.output)
      )
        continue;
      if (part.output.type === 'json') observeStructuredFieldResults(part.output.value, capture);
    }
  }
};

type MessageEvidenceConversion =
  | { readonly ok: true; readonly selections: readonly CandidateSelection[] }
  | { readonly ok: false; readonly code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE' };

const evaluationFieldsFor = (runtimeField: string): readonly string[] => {
  switch (runtimeField) {
    case 'identity':
    case 'name':
      return ['name'];
    case 'opening_hours':
    case 'openUntil':
      return ['openUntil'];
    case 'price':
    case 'priceLevel':
      return ['priceLevel'];
    default:
      return [];
  }
};

const freshAt = (freshUntil: string | null, now: string): boolean => {
  if (freshUntil === null) return true;
  const expiry = Date.parse(freshUntil);
  const current = Date.parse(now);
  return Number.isFinite(expiry) && Number.isFinite(current) && expiry > current;
};

const displayableAt = (
  retention: AssistantMessageResponse['message'][number]['retention'],
  now: string,
): boolean => {
  if (retention.displayPolicyStatus !== 'available') return false;
  const current = Date.parse(now);
  if (!Number.isFinite(current)) return false;
  const deadlines = [retention.sessionExpiresAt, retention.displayUntil, retention.freshUntil];
  return deadlines.every((deadline) => deadline === null || Date.parse(deadline) > current);
};

const samePublicEvidence = (
  left: AssistantMessageResponse['message'][number]['evidence'][number],
  right: AssistantMessageResponse['message'][number]['evidence'][number],
): boolean => JSON.stringify(left) === JSON.stringify(right);

const mappingFailure = (
  mapping: CandidateIdentityMapping | CandidateIdentityMappingFailure | undefined,
): MessageEvidenceConversion | undefined => {
  if (mapping === undefined || !mapping.ok) {
    return { ok: false, code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE' };
  }
  return undefined;
};

/**
 * Converts a grounded public message into candidate selections only when each
 * public evidence ID joins to a structured runtime observation and an exact
 * fixture candidate/field. No claim value is inferred from message text.
 */
export const messageSelectionsForEvaluation = (input: {
  readonly response: AssistantMessageResponse;
  readonly evaluationCase: EvaluationCase;
  readonly evidenceReferences: readonly RuntimeEvidenceReference[];
  readonly evidenceReferenceMapAvailable: boolean;
  readonly candidateIdentityMap: CandidateIdentityMapping | undefined;
}): MessageEvidenceConversion => {
  const messagesWithEvidence = input.response.message.filter(
    (message) => message.evidenceIds.length > 0,
  );
  if (messagesWithEvidence.length > 0 && !input.evidenceReferenceMapAvailable) {
    return { ok: false, code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE' };
  }
  const candidateMappingFailure = mappingFailure(input.candidateIdentityMap);
  const runtimeByObservation = new Map<string, RuntimeEvidenceReference>();
  for (const reference of input.evidenceReferences) {
    const existing = runtimeByObservation.get(reference.observationId);
    if (
      existing !== undefined &&
      (existing.candidateId !== reference.candidateId || existing.field !== reference.field)
    ) {
      return { ok: false, code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE' };
    }
    runtimeByObservation.set(reference.observationId, reference);
  }
  const publicEvidence = new Map<
    string,
    AssistantMessageResponse['message'][number]['evidence'][number]
  >();
  for (const message of input.response.message) {
    for (const evidence of message.evidence) {
      const existing = publicEvidence.get(evidence.evidenceId);
      if (existing !== undefined && !samePublicEvidence(existing, evidence)) {
        return { ok: false, code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE' };
      }
      publicEvidence.set(evidence.evidenceId, evidence);
    }
  }
  const selections = new Map<
    string,
    { readonly evidenceIds: Set<string>; readonly why: string[] }
  >();
  for (const message of input.response.message) {
    if (message.evidenceIds.length === 0) continue;
    if (message.basis !== 'grounded') {
      return { ok: false, code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE' };
    }
    for (const evidenceId of message.evidenceIds) {
      const publicReference = publicEvidence.get(evidenceId);
      const runtimeReference = runtimeByObservation.get(evidenceId);
      if (
        publicReference === undefined ||
        runtimeReference === undefined ||
        !displayableAt(publicReference.retention, input.evaluationCase.context.now) ||
        !freshAt(runtimeReference.freshUntil ?? null, input.evaluationCase.context.now)
      ) {
        return { ok: false, code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE' };
      }
      if (candidateMappingFailure !== undefined || input.candidateIdentityMap === undefined) {
        return (
          candidateMappingFailure ?? {
            ok: false,
            code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE',
          }
        );
      }
      const candidateId = input.candidateIdentityMap.byRuntimeCandidateId.get(
        runtimeReference.candidateId,
      );
      const fields = evaluationFieldsFor(runtimeReference.field);
      if (candidateId === undefined) {
        return { ok: false, code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE' };
      }
      // A runtime field can be absent from a particular golden case. Keep the
      // candidate join partial rather than inventing a value or field mapping;
      // the candidate still needs at least one exact mapped evidence below.
      if (fields.length === 0) continue;
      const matchingEvidence = input.evaluationCase.context.evidence.filter(
        (entry) =>
          entry.subjectId === candidateId &&
          fields.includes(entry.field) &&
          freshAt(entry.freshUntil, input.evaluationCase.context.now),
      );
      if (matchingEvidence.length > 1) {
        return { ok: false, code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE' };
      }
      if (matchingEvidence.length === 0) continue;
      const evaluationEvidenceId = matchingEvidence[0]?.id;
      if (evaluationEvidenceId === undefined) {
        return { ok: false, code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE' };
      }
      const selection = selections.get(candidateId) ?? {
        evidenceIds: new Set<string>(),
        why: [],
      };
      selection.evidenceIds.add(evaluationEvidenceId);
      if (!selection.why.includes(message.text)) selection.why.push(message.text);
      selections.set(candidateId, selection);
    }
  }
  if (messagesWithEvidence.length > 0 && selections.size === 0) {
    return { ok: false, code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE' };
  }
  return {
    ok: true,
    selections: [...selections].map(([candidateId, selection]) => ({
      candidateId,
      evidenceIds: [...selection.evidenceIds],
      why: selection.why.join('\n'),
    })),
  };
};
