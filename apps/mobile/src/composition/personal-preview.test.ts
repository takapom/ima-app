import { describe, expect, it } from 'vitest';
import { personalPreviewConfiguration } from '@mobile/composition/personal-preview';

const env = {
  EXPO_PUBLIC_PERSONAL_PREVIEW: 'true',
  EXPO_PUBLIC_ENVIRONMENT: 'staging',
  EXPO_PUBLIC_API_MODE: 'live',
  EXPO_PUBLIC_API_BASE_URL: 'https://staging.example.invalid',
};

describe('personal preview configuration', () => {
  it('preserves ordinary app composition without explicit opt-in', () => {
    expect(personalPreviewConfiguration({}, 'ios')).toEqual({ kind: 'disabled' });
    expect(
      personalPreviewConfiguration({ ...env, EXPO_PUBLIC_PERSONAL_PREVIEW: 'false' }, 'ios'),
    ).toEqual({ kind: 'disabled' });
  });
  it('enables only a live iOS staging connection over HTTPS', () => {
    expect(personalPreviewConfiguration(env, 'ios')).toEqual({
      kind: 'enabled',
      target: { environment: 'staging', apiBaseUrl: env.EXPO_PUBLIC_API_BASE_URL },
    });
    for (const platform of ['web', 'android'])
      expect(personalPreviewConfiguration(env, platform)).toEqual({ kind: 'invalid' });
    for (const override of [
      { EXPO_PUBLIC_ENVIRONMENT: 'production' },
      { EXPO_PUBLIC_ENVIRONMENT: 'dev' },
      { EXPO_PUBLIC_API_MODE: 'fixture' },
      { EXPO_PUBLIC_API_BASE_URL: 'http://localhost:8787' },
      { EXPO_PUBLIC_API_BASE_URL: 'https://user:secret@example.invalid' },
      { EXPO_PUBLIC_API_BASE_URL: 'https://example.invalid?token=secret' },
    ])
      expect(personalPreviewConfiguration({ ...env, ...override }, 'ios')).toEqual({
        kind: 'invalid',
      });
  });
});
