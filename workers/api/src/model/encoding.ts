import type { ModelMessage } from 'ai';
import type { ProjectedModelContext } from '@ima/core';
import { MODEL_SYSTEM_PROMPT } from './system-prompt';

/** ModelMessage is the public AI SDK prompt type consumed by generateText/streamText. */
export type ModelInputMessage = ModelMessage;

export type ModelContextEnvelope = {
  readonly kind: 'ima_turn_context';
  readonly originalUserText: string;
  readonly context: {
    readonly threadId: string;
    readonly turnId: string;
    readonly revision: number;
    readonly serverNow: string;
    readonly location: ProjectedModelContext['location'];
    readonly preferences: ProjectedModelContext['preferences'];
    readonly conditions: ProjectedModelContext['conditions'];
    readonly stationDirectory: ProjectedModelContext['stationDirectory'];
    readonly history: ProjectedModelContext['history'];
    readonly cardSet: ProjectedModelContext['cardSet'];
    readonly evidence: ProjectedModelContext['evidence'];
    readonly capabilities: ProjectedModelContext['capabilities'];
    readonly budget: ProjectedModelContext['budget'];
  };
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

const contextEnvelope = (context: ProjectedModelContext): ModelContextEnvelope => ({
  kind: 'ima_turn_context',
  originalUserText: context.userText,
  context: {
    threadId: context.threadId,
    turnId: context.turnId,
    revision: context.revision,
    serverNow: context.serverNow,
    location: context.location,
    preferences: context.preferences,
    conditions: context.conditions,
    stationDirectory: context.stationDirectory,
    history: context.history,
    cardSet: context.cardSet,
    evidence: context.evidence,
    capabilities: context.capabilities,
    budget: context.budget,
  },
});

export const encodeModelContext = (
  context: ProjectedModelContext,
): readonly [ModelInputMessage, ModelInputMessage] => [
  { role: 'system', content: MODEL_SYSTEM_PROMPT },
  { role: 'user', content: serialize(contextEnvelope(context)) },
];
