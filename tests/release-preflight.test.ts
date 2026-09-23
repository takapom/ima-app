import { describe, expect, it } from 'vitest';
import {
  mobileReleaseMetadataFromConfig,
  preflightRelease,
  runReleasePreflightCli,
  type MobileReleaseMetadata,
} from '../scripts/release-preflight';
import type { EnvironmentValues } from '../scripts/environment-preflight';

const mobile: MobileReleaseMetadata = {
  privacyPolicyUrl: 'https://policy.example.invalid/ima',
  locationPermissionConfigured: true,
  attributionPolicyDocumentPresent: true,
  qualityScope: 'ebisu-daikanyama',
  secretFreeConfig: true,
};

const stagingLive: EnvironmentValues = {
  IMA_ENV: 'staging',
  IMA_RUNTIME_MODE: 'live',
  APP_TOKEN: 'staging-app-token',
  EXPO_PUBLIC_API_BASE_URL: 'https://staging.example.invalid',
  APP_ATTEST_MODE: 'required',
  APP_ATTEST_ENVIRONMENT: 'production',
  IMA_RUNTIME_FLAGS_CONNECTED: '1',
  IMA_PROVIDER_OPENAI: 'true',
  IMA_PROVIDER_HOTPEPPER: 'true',
  IMA_SHARE_LINE_SCHEME: 'true',
  IMA_PROVIDER_LIVE_CONFIRM: 'YES',
  IMA_PROVIDER_BILLING_CONFIRM: 'YES',
  IMA_PROVIDER_PERMISSION_CONFIRM: 'YES',
  OPENAI_API_KEY: 'openai-key-not-logged',
  HOTPEPPER_API_KEY: 'hotpepper-key-not-logged',
  PLACES_CURSOR_SECRET: 'cursor-secret-not-logged',
  IMA_TESTFLIGHT_INVITE_CONFIRM: 'YES',
  IMA_RELEASE_QUALITY_SCOPE: 'ebisu-daikanyama',
  EAS_PROJECT_ID: '00000000-0000-4000-8000-000000000000',
  EXPO_IOS_BUNDLE_IDENTIFIER: 'com.example.ima',
  CLOUDFLARE_ACCOUNT_ID: 'account-id-not-logged',
  CLOUDFLARE_API_TOKEN: 'cloudflare-token-not-logged',
  CLOUDFLARE_WORKER_ROUTE: 'staging.example.invalid/*',
  IMA_DEPLOY_CONFIRM: 'YES',
};

const check = (report: ReturnType<typeof preflightRelease>, name: string) =>
  report.checks.find((candidate) => candidate.name === name);

describe('release preflight', () => {
  it('maps internal and external tracks to staging and production', () => {
    const internal = preflightRelease('internal', stagingLive, mobile);
    const external = preflightRelease(
      'external',
      { ...stagingLive, IMA_ENV: 'production' },
      mobile,
    );

    expect(internal.target).toBe('staging');
    expect(external.target).toBe('production');
    expect(external.checks).toContainEqual(
      expect.objectContaining({ name: 'EXTERNAL_PRODUCTION_FLAGS', status: 'unverified' }),
    );
  });

  it('keeps a configured release partial until external evidence exists', () => {
    const report = preflightRelease('internal', stagingLive, mobile);

    expect(report.status).toBe('partial');
    expect(report.localChecksReady).toBe(true);
    expect(report.externalEvidenceVerified).toBe(false);
    expect(report.releaseAllowed).toBe(false);
    expect(check(report, 'TESTFLIGHT_BUILD')).toMatchObject({ status: 'unverified' });
    expect(check(report, 'APPLE_SIGNING')).toMatchObject({ status: 'unverified' });
    expect(check(report, 'REAL_DEVICE')).toMatchObject({ status: 'unverified' });
  });

  it('blocks fixture mode and disabled required capabilities', () => {
    const report = preflightRelease(
      'internal',
      {
        IMA_ENV: 'staging',
        IMA_RUNTIME_MODE: 'fixture',
        APP_TOKEN: 'fixture-token',
        EXPO_PUBLIC_API_BASE_URL: 'https://staging.example.invalid',
        IMA_PROVIDER_OPENAI: 'false',
        IMA_PROVIDER_HOTPEPPER: 'false',
      },
      mobile,
    );

    expect(report.status).toBe('blocked');
    expect(check(report, 'LIVE_PROVIDER_EVIDENCE')).toMatchObject({ status: 'blocked' });
    expect(check(report, 'IMA_PROVIDER_OPENAI')).toMatchObject({ status: 'blocked' });
    expect(check(report, 'IMA_PROVIDER_HOTPEPPER')).toMatchObject({ status: 'blocked' });
  });

  it('requires a secure privacy URL and never echoes it or secrets', () => {
    const output: string[] = [];
    const code = runReleasePreflightCli(
      ['--track', 'internal'],
      { ...stagingLive, EXPO_PUBLIC_PRIVACY_POLICY_URL: 'https://policy.example.invalid/ima' },
      (line) => output.push(line),
      { expo: { ios: { infoPlist: { NSLocationWhenInUseUsageDescription: '現在地を使います' } } } },
      true,
    );

    expect(code).toBe(2);
    expect(output.join('\n')).not.toContain('openai-key-not-logged');
    expect(output.join('\n')).not.toContain('hotpepper-key-not-logged');
    expect(output.join('\n')).not.toContain('cloudflare-token-not-logged');
    const report = JSON.parse(output[0] ?? '') as ReturnType<typeof preflightRelease>;
    expect(check(report, 'PRIVACY_POLICY_HOSTING')).toMatchObject({
      status: 'unverified',
    });
  });

  it('blocks credential-bearing or absent privacy URLs', () => {
    const credentialUrl = preflightRelease('internal', stagingLive, {
      ...mobile,
      privacyPolicyUrl: 'https://user:pass@policy.example.invalid/ima',
    });
    const absentUrl = preflightRelease('internal', stagingLive, {
      ...mobile,
      privacyPolicyUrl: undefined,
    });

    expect(check(credentialUrl, 'PRIVACY_POLICY_HOSTING')).toMatchObject({ status: 'invalid' });
    expect(check(absentUrl, 'PRIVACY_POLICY_HOSTING')).toMatchObject({ status: 'missing' });
    expect(credentialUrl.status).toBe('blocked');
    expect(absentUrl.status).toBe('blocked');
  });

  it('requires the location description, attribution review, and non-hard-locked quality scope', () => {
    const config = {
      expo: { ios: { infoPlist: { NSLocationWhenInUseUsageDescription: '現在地を使います' } } },
    };
    const metadata = mobileReleaseMetadataFromConfig(
      config,
      { ...stagingLive, EXPO_PUBLIC_PRIVACY_POLICY_URL: mobile.privacyPolicyUrl },
      true,
    );
    const hardLocked = preflightRelease('internal', stagingLive, {
      ...metadata,
      qualityScope: 'hard-lock',
    });
    const noLocation = preflightRelease('internal', stagingLive, {
      ...metadata,
      locationPermissionConfigured: false,
    });

    expect(metadata.locationPermissionConfigured).toBe(true);
    expect(metadata.secretFreeConfig).toBe(true);
    expect(check(hardLocked, 'FONT_LICENSE_ATTRIBUTION')).toMatchObject({ status: 'unverified' });
    expect(check(hardLocked, 'PRIVACY_DATA_LIFECYCLE')).toMatchObject({ status: 'unverified' });
    expect(check(hardLocked, 'QUALITY_SCOPE')).toMatchObject({ status: 'invalid' });
    expect(check(noLocation, 'LOCATION_PERMISSION')).toMatchObject({ status: 'missing' });
    expect(hardLocked.status).toBe('blocked');
    expect(noLocation.status).toBe('blocked');
  });

  it('does not trust a secret placed in mobile config', () => {
    const metadata = mobileReleaseMetadataFromConfig(
      {
        expo: {
          extra: { APP_TOKEN: 'must-not-be-bundled' },
          ios: { infoPlist: { NSLocationWhenInUseUsageDescription: '現在地を使います' } },
        },
      },
      stagingLive,
      true,
    );

    expect(metadata.secretFreeConfig).toBe(false);
    expect(
      check(preflightRelease('internal', stagingLive, metadata), 'MOBILE_SECRET_BOUNDARY'),
    ).toMatchObject({ status: 'blocked' });
  });

  it('requires explicit invite consent', () => {
    const report = preflightRelease(
      'internal',
      {
        ...stagingLive,
        IMA_TESTFLIGHT_INVITE_CONFIRM: 'NO',
        IMA_SHARE_LINE_SCHEME: 'false',
      },
      mobile,
    );

    expect(check(report, 'INVITE_CONSENT')).toMatchObject({ status: 'invalid' });
    expect(check(report, 'SHARE_EVENT_PATH')).toMatchObject({ status: 'unverified' });
  });

  it('rejects an external track when its environment is not production', () => {
    const report = preflightRelease('external', stagingLive, mobile);

    expect(report.status).toBe('blocked');
    expect(report.environment.checks).toContainEqual(
      expect.objectContaining({ name: 'IMA_ENV', status: 'invalid' }),
    );
  });

  it('requires an explicit track for the CLI', () => {
    const output: string[] = [];

    expect(runReleasePreflightCli([], stagingLive, (line) => output.push(line))).toBe(1);
    expect(output).toEqual([JSON.stringify({ status: 'blocked', code: 'TRACK_REQUIRED' })]);
  });
});
