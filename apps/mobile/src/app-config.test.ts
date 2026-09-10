import { describe, expect, it } from 'vitest';
import { createMobileConfig } from '../app.config';
import type { ExpoConfig } from 'expo/config';

const baseConfig: Partial<ExpoConfig> = {
  name: 'ima',
  slug: 'ima',
  ios: { supportsTablet: false },
};

const projectId = '11111111-1111-4111-8111-111111111111';

describe('mobile dynamic config', () => {
  it('keeps local development free of fabricated external identity', () => {
    const config = createMobileConfig(baseConfig, {
      EXPO_PUBLIC_ENVIRONMENT: 'dev',
    });

    expect(config.ios?.bundleIdentifier).toBeUndefined();
    expect(config.extra ?? {}).not.toHaveProperty('eas.projectId');
  });

  it('injects build identity from the environment for staging', () => {
    const config = createMobileConfig(baseConfig, {
      EXPO_PUBLIC_ENVIRONMENT: 'staging',
      EXPO_PUBLIC_API_BASE_URL: 'https://staging.example.invalid',
      EXPO_IOS_BUNDLE_IDENTIFIER: 'com.example.ima',
      EAS_PROJECT_ID: projectId,
    });

    expect(config.ios?.bundleIdentifier).toBe('com.example.ima');
    expect(config.extra).toMatchObject({ eas: { projectId } });
  });

  it('rejects missing or malformed identity for an external build', () => {
    expect(() =>
      createMobileConfig(baseConfig, {
        EXPO_PUBLIC_ENVIRONMENT: 'production',
        EXPO_PUBLIC_API_BASE_URL: 'https://production.example.invalid',
      }),
    ).toThrow('External iOS builds require');
    expect(() =>
      createMobileConfig(baseConfig, {
        EXPO_PUBLIC_ENVIRONMENT: 'production',
        EXPO_PUBLIC_API_BASE_URL: 'https://production.example.invalid',
        EXPO_IOS_BUNDLE_IDENTIFIER: 'example.invalid',
        EAS_PROJECT_ID: 'not-a-uuid',
      }),
    ).toThrow('EAS_PROJECT_ID must be a UUID');
  });

  it('rejects missing, non-HTTPS, and credential-bearing external endpoints', () => {
    const identity = {
      EXPO_PUBLIC_ENVIRONMENT: 'staging',
      EXPO_IOS_BUNDLE_IDENTIFIER: 'com.example.ima',
      EAS_PROJECT_ID: projectId,
    };
    expect(() => createMobileConfig(baseConfig, identity)).toThrow(
      'require EXPO_PUBLIC_API_BASE_URL',
    );
    expect(() =>
      createMobileConfig(baseConfig, {
        ...identity,
        EXPO_PUBLIC_API_BASE_URL: 'http://staging.example.invalid',
      }),
    ).toThrow('non-local HTTPS URL');
    expect(() =>
      createMobileConfig(baseConfig, {
        ...identity,
        EXPO_PUBLIC_API_BASE_URL: 'https://user:pass@staging.example.invalid',
      }),
    ).toThrow('non-local HTTPS URL');
  });
});
