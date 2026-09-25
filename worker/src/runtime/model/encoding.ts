import type { ModelMessage } from 'ai';
import type { ProjectedModelContext } from '@worker/application/model-context/model-context';
import { MODEL_SYSTEM_PROMPT } from '@worker/runtime/model/system-prompt';
import {
  summarizeFieldForModel,
  type ModelFieldSummary,
} from '@worker/application/model-context/model-field-summary';

/** ModelMessage is the public AI SDK prompt type consumed by generateText/streamText. */
export type ModelInputMessage = ModelMessage;

type ModelEvidenceSummary = {
  readonly candidateId: string;
  readonly field: ProjectedModelContext['evidence'][number]['field'];
  readonly status: ProjectedModelContext['evidence'][number]['status'];
} & Partial<ModelFieldSummary>;

/**
 * The turn context as the model sees it. Keys run from the least to the most volatile so a
 * stable prefix can be reused across turns, and the original text comes last. Observation IDs,
 * times and sources stay in the harness.
 */
export type ModelContextEnvelope = {
  readonly kind: 'ima_turn_context';
  readonly context: {
    readonly capabilities: ProjectedModelContext['capabilities'];
    readonly preferences: ProjectedModelContext['preferences'];
    readonly history: readonly Pick<ProjectedModelContext['history'][number], 'role' | 'text'>[];
    readonly conversationMemory?: ProjectedModelContext['conversationMemory'];
    readonly cardSet: ProjectedModelContext['cardSet'];
    readonly evidence: readonly ModelEvidenceSummary[];
    readonly location: ProjectedModelContext['location'];
    readonly serverNow: string;
    readonly budget: ProjectedModelContext['budget'];
  };
  readonly originalUserText: string;
};

export type ModelEncodingErrorCode = 'INVALID_SERIALIZATION';

export class ModelEncodingError extends Error {
  readonly code: ModelEncodingErrorCode;

  constructor(code: ModelEncodingErrorCode, message: string) {
    super(message);
    this.name = 'ModelEncodingError';
    this.code = code;
  }
}

const serialize = (value: unknown): string => {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ModelEncodingError('INVALID_SERIALIZATION', 'model message is not serializable');
  }
  if (encoded === undefined) {
    throw new ModelEncodingError('INVALID_SERIALIZATION', 'model message is not serializable');
  }
  return encoded;
};

const evidenceSummary = (
  evidence: ProjectedModelContext['evidence'][number],
): ModelEvidenceSummary => {
  const base = { candidateId: evidence.candidateId, field: evidence.field };
  if (evidence.status !== 'known') return { ...base, status: evidence.status };
  const summary = summarizeFieldForModel(evidence.field, evidence.value);
  return summary === undefined
    ? { ...base, status: 'withheld' }
    : { ...base, status: 'known', ...summary };
};

const contextEnvelope = (context: ProjectedModelContext): ModelContextEnvelope => ({
  kind: 'ima_turn_context',
  context: {
    capabilities: context.capabilities,
    preferences: context.preferences,
    history: context.history.map(({ role, text }) => ({ role, text })),
    ...(context.conversationMemory === undefined
      ? {}
      : { conversationMemory: context.conversationMemory }),
    cardSet: context.cardSet,
    evidence: context.evidence.map(evidenceSummary),
    location: context.location,
    serverNow: context.serverNow,
    budget: context.budget,
  },
  originalUserText: context.userText,
});

export const encodeModelContext = (
  context: ProjectedModelContext,
): readonly [ModelInputMessage, ModelInputMessage] => [
  { role: 'system', content: MODEL_SYSTEM_PROMPT },
  { role: 'user', content: serialize(contextEnvelope(context)) },
];
