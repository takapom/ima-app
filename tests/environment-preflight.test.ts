import { describe, expect, it } from 'vitest';
import {
  preflightEnvironment,
  runEnvironmentPreflightCli,
  type EnvironmentValues,
} from '../scripts/environment-preflight';

const devFixture: EnvironmentValues = {
  IMA_ENV: 'dev',
  IMA_RUNTIME_MODE: 'fixture',
  APP_TOKEN: 'local-app-token',
  EXPO_PUBLIC_API_BASE_URL: 'http://localhost:8787',
};

const liveValues: EnvironmentValues = {
  IMA_ENV: 'staging',
  IMA_RUNTIME_MODE: 'live',
  APP_TOKEN: 'staging-app-token',
  EXPO_PUBLIC_API_BASE_URL: 'https://staging.example.invalid',
  IMA_PROVIDER_LIVE_CONFIRM: 'YES',
  IMA_PROVIDER_BILLING_CONFIRM: 'YES',
  IMA_PROVIDER_PERMISSION_CONFIRM: 'YES',
  OPENAI_API_KEY: 'openai-key-not-logged',
  GOOGLE_PLACES_API_KEY: 'places-key-not-logged',
  GOOGLE_ROUTES_API_KEY: 'routes-key-not-logged',
  PLACES_CURSOR_SECRET: 'cursor-secret-not-logged',
  PHOTO_TOKEN_SECRET: 'photo-secret-not-logged',
};

describe('environment preflight', () => {
  it('marks local fixture configuration ready without claiming a runnable runtime', () => {
    const report = preflightEnvironment('dev', devFixture);

    expect(report).toMatchObject({
      target: 'dev',
      mode: 'fixture',
      status: 'ready',
      runtimeVerified: false,
      runnable: false,
      deployAllowed: false,
    });
  });

  it('blocks missing or placeholder authentication and endpoint values', () => {
    const report = preflightEnvironment('dev', {
      IMA_ENV: 'dev',
      IMA_RUNTIME_MODE: 'fixture',
      APP_TOKEN: 'replace-me',
      EXPO_PUBLIC_API_BASE_URL: 'not-a-url',
    });

    expect(report.status).toBe('blocked');
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'APP_TOKEN', status: 'invalid' }),
        expect.objectContaining({ name: 'EXPO_PUBLIC_API_BASE_URL', status: 'invalid' }),
      ]),
    );
  });

  it('rejects fixture bypass for staging and production targets', () => {
    const report = preflightEnvironment('production', {
      ...devFixture,
      IMA_ENV: 'production',
      EXPO_PUBLIC_API_BASE_URL: 'https://api.example.invalid',
    });

    expect(report.status).toBe('blocked');
    expect(report.checks).toContainEqual({
      name: 'PRODUCTION_FIXTURE_BYPASS',
      status: 'blocked',
      detail: 'fixture mode cannot be deployed to staging or production',
    });
  });

  it('requires explicit confirmations and all provider secrets for live mode', () => {
    const report = preflightEnvironment('staging', {
      IMA_ENV: 'staging',
      IMA_RUNTIME_MODE: 'live',
      APP_TOKEN: 'staging-app-token',
      EXPO_PUBLIC_API_BASE_URL: 'https://staging.example.invalid',
    });

    expect(report.status).toBe('blocked');
    expect(report.checks.filter(({ name }) => name.endsWith('_CONFIRM'))).toHaveLength(3);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'OPENAI_API_KEY', status: 'missing' }),
        expect.objectContaining({ name: 'PHOTO_TOKEN_SECRET', status: 'missing' }),
      ]),
    );
  });

  it('does not claim production readiness while App Attest and runtime flags are unverified', () => {
    const report = preflightEnvironment('production', {
      ...liveValues,
      IMA_ENV: 'production',
      EXPO_PUBLIC_API_BASE_URL: 'https://api.example.invalid',
    });

    expect(report.status).toBe('blocked');
    expect(report.runtimeVerified).toBe(false);
    expect(report.deployAllowed).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'APP_ATTEST_MODE', status: 'missing' }),
        expect.objectContaining({ name: 'IMA_RUNTIME_FLAGS_CONNECTED', status: 'unverified' }),
      ]),
    );
  });

  it('does not trust self-reported production gates', () => {
    const report = preflightEnvironment('production', {
      ...liveValues,
      IMA_ENV: 'production',
      EXPO_PUBLIC_API_BASE_URL: 'https://api.example.invalid',
      APP_ATTEST_MODE: 'production',
      IMA_RUNTIME_FLAGS_CONNECTED: '1',
    });

    expect(report.status).toBe('partial');
    expect(report.deployAllowed).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'APP_ATTEST_MODE', status: 'unverified' }),
        expect.objectContaining({ name: 'IMA_RUNTIME_FLAGS_CONNECTED', status: 'unverified' }),
      ]),
    );

    const output: string[] = [];
    runEnvironmentPreflightCli(
      ['--target', 'production'],
      {
        ...liveValues,
        IMA_ENV: 'production',
        EXPO_PUBLIC_API_BASE_URL: 'https://api.example.invalid',
        APP_ATTEST_MODE: 'production',
        IMA_RUNTIME_FLAGS_CONNECTED: '1',
      },
      (line) => output.push(line),
    );
    expect(output.join('\n')).not.toContain('openai-key-not-logged');
    expect(output.join('\n')).not.toContain('places-key-not-logged');
  });

  it('requires an iOS identity only when a build preflight is requested', () => {
    const output: string[] = [];
    const code = runEnvironmentPreflightCli(
      ['--target', 'dev'],
      { ...devFixture, IMA_PREFLIGHT_BUILD: '1' },
      (line) => output.push(line),
    );

    expect(code).toBe(1);
    expect(output.join('\n')).not.toContain('local-app-token');
    expect(output.join('\n')).toContain('EAS_PROJECT_ID');
  });
});
