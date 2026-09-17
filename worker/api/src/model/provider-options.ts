import { OPENAI_REASONING_EFFORT } from './provider-config';

/**
 * Request-scoped options passed to AI SDK's OpenAI Responses model.
 *
 * This module deliberately has no provider SDK import so the fixed profile can be tested
 * while the manifest dependency is not yet synchronized locally.
 */
export type OpenAIProviderRequestOptions = {
  readonly openai: {
    readonly reasoningEffort: typeof OPENAI_REASONING_EFFORT;
    readonly strictJsonSchema: false;
    readonly store: false;
  };
};

export const OPENAI_PROVIDER_REQUEST_OPTIONS: OpenAIProviderRequestOptions = Object.freeze({
  openai: Object.freeze({
    reasoningEffort: OPENAI_REASONING_EFFORT,
    strictJsonSchema: false,
    store: false,
  }),
});
