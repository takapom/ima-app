import { describe, expect, it } from 'vitest';
import {
  OPENAI_PROVIDER_REQUEST_OPTIONS,
  type OpenAIProviderRequestOptions,
} from '@worker/infrastructure/adapters/outbound/providers/openai/provider-options';
import {
  OPENAI_MODEL_NAME,
  OPENAI_REASONING_EFFORT,
} from '@worker/infrastructure/adapters/outbound/providers/openai/provider-config';

describe('OpenAI Responses request profile', () => {
  it('keeps the fixed model options independent of the live SDK', () => {
    const options: OpenAIProviderRequestOptions = OPENAI_PROVIDER_REQUEST_OPTIONS;

    expect(options).toEqual({
      openai: {
        reasoningEffort: OPENAI_REASONING_EFFORT,
        strictJsonSchema: false,
        store: false,
      },
    });
    expect(OPENAI_MODEL_NAME).toBe('gpt-5.6-luna');
  });

  it('freezes the outer and provider option objects', () => {
    expect(Object.isFrozen(OPENAI_PROVIDER_REQUEST_OPTIONS)).toBe(true);
    expect(Object.isFrozen(OPENAI_PROVIDER_REQUEST_OPTIONS.openai)).toBe(true);
  });
});
