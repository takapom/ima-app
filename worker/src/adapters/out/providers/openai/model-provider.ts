import { createOpenAI, type OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import {
  resolveOpenAIModelConfig,
  type ModelProviderConfig,
} from '@worker/adapters/out/providers/openai/provider-config';
import {
  OPENAI_PROVIDER_REQUEST_OPTIONS,
  type OpenAIProviderRequestOptions,
} from '@worker/adapters/out/providers/openai/provider-options';

/** AI SDK 6 accepts model specification v3 providers from the compatible OpenAI package. */
export type OpenAIResponsesModel = Extract<LanguageModel, { specificationVersion: 'v3' }>;

export type LiveModelProvider = {
  readonly model: OpenAIResponsesModel;
  /** Merge this value into each AI SDK call's providerOptions field. */
  readonly providerOptions: OpenAIProviderRequestOptions;
  /** Non-secret profile metadata for runtime diagnostics and model selection. */
  readonly profile: Readonly<Pick<ModelProviderConfig, 'provider' | 'model' | 'reasoningEffort'>>;
};

const providerOptions = OPENAI_PROVIDER_REQUEST_OPTIONS satisfies {
  readonly openai: OpenAILanguageModelResponsesOptions;
};

/**
 * Creates the live OpenAI Responses model after validating the server-owned environment.
 *
 * Construction does not call the provider. The API key is used only in the SDK provider
 * instance and is intentionally absent from the returned binding and diagnostic profile.
 */
export const createLiveOpenAIProvider = (env: unknown): LiveModelProvider => {
  const config = resolveOpenAIModelConfig(env);
  const openai = createOpenAI({ apiKey: config.apiKey });

  return {
    model: openai.responses(config.model),
    providerOptions,
    profile: {
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
    },
  };
};
