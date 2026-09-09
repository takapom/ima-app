export const OPENAI_API_KEY_NAME = 'OPENAI_API_KEY' as const;
export const OPENAI_MODEL_NAME = 'gpt-5.6-luna' as const;
export const OPENAI_REASONING_EFFORT = 'low' as const;

export type ModelProviderConfigurationErrorCode = 'MODEL_PROVIDER_KEY_MISSING';

export class ModelProviderConfigurationError extends Error {
  readonly code: ModelProviderConfigurationErrorCode;

  constructor(code: ModelProviderConfigurationErrorCode, message: string) {
    super(message);
    this.name = 'ModelProviderConfigurationError';
    this.code = code;
  }
}

export type ModelProviderConfig = {
  readonly provider: 'openai';
  readonly model: typeof OPENAI_MODEL_NAME;
  readonly reasoningEffort: typeof OPENAI_REASONING_EFFORT;
  /** Consumed only by the eventual provider factory; never encode or log this value. */
  readonly apiKey: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Resolves live provider settings without a fixture fallback or a provider SDK dependency. */
export const resolveOpenAIModelConfig = (env: unknown): ModelProviderConfig => {
  const apiKey = isRecord(env) ? env[OPENAI_API_KEY_NAME] : undefined;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new ModelProviderConfigurationError(
      'MODEL_PROVIDER_KEY_MISSING',
      `${OPENAI_API_KEY_NAME} is required for the live model profile`,
    );
  }
  return {
    provider: 'openai',
    model: OPENAI_MODEL_NAME,
    reasoningEffort: OPENAI_REASONING_EFFORT,
    apiKey,
  };
};
