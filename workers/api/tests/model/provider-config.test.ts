import { describe, expect, it } from 'vitest';
import {
  ModelProviderConfigurationError,
  OPENAI_API_KEY_NAME,
  OPENAI_MODEL_NAME,
  OPENAI_REASONING_EFFORT,
  resolveOpenAIModelConfig,
} from '../../src/model/provider-config';

describe('live model provider configuration', () => {
  it.each([undefined, '', '   ', 42])('rejects an absent or invalid %s value', (apiKey) => {
    expect(() => resolveOpenAIModelConfig({ [OPENAI_API_KEY_NAME]: apiKey })).toThrowError(
      ModelProviderConfigurationError,
    );
  });

  it('does not use fixture settings when the live key is absent', () => {
    expect(() => resolveOpenAIModelConfig({ MODEL_FIXTURE: 'fixture-provider' })).toThrowError(
      ModelProviderConfigurationError,
    );
  });

  it('returns the fixed candidate settings without changing the key', () => {
    const config = resolveOpenAIModelConfig({ [OPENAI_API_KEY_NAME]: 'sk-test-only' });
    expect(config).toMatchObject({
      provider: 'openai',
      model: OPENAI_MODEL_NAME,
      reasoningEffort: OPENAI_REASONING_EFFORT,
    });
    expect(config.apiKey).toBe('sk-test-only');
  });

  it('returns a stable code and safe message for a missing key', () => {
    let thrown: unknown;
    try {
      resolveOpenAIModelConfig({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ModelProviderConfigurationError);
    if (!(thrown instanceof ModelProviderConfigurationError)) return;
    expect(thrown.code).toBe('MODEL_PROVIDER_KEY_MISSING');
    expect(thrown.message).toContain(OPENAI_API_KEY_NAME);
  });
});
