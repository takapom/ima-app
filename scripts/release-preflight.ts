import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  preflightEnvironment,
  type DeploymentTarget,
  type EnvironmentPreflightReport,
  type EnvironmentValues,
  type PreflightCheckStatus,
} from './environment-preflight';

export type { EnvironmentValues } from './environment-preflight';

export type ReleaseTrack = 'internal' | 'external';
export type ReleaseStatus = 'ready' | 'partial' | 'blocked';
export type ReleaseCheckStatus = PreflightCheckStatus;

export type MobileReleaseMetadata = {
  readonly privacyPolicyUrl?: string | undefined;
  readonly locationPermissionConfigured: boolean;
  readonly attributionPolicyDocumentPresent: boolean;
  readonly qualityScope?: string | undefined;
  readonly secretFreeConfig: boolean;
};

export type ReleaseCheck = {
  readonly name: string;
  readonly status: ReleaseCheckStatus;
  readonly detail: string;
};

export type ReleasePreflightReport = {
  readonly track: ReleaseTrack;
  readonly target: DeploymentTarget;
  readonly status: ReleaseStatus;
  readonly localChecksReady: boolean;
  /** External evidence is intentionally never inferred from configuration. */
  readonly externalEvidenceVerified: false;
  readonly releaseAllowed: false;
  readonly environment: EnvironmentPreflightReport;
  readonly checks: readonly ReleaseCheck[];
};

const valueFor = (env: EnvironmentValues, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};

const targetFor = (track: ReleaseTrack): DeploymentTarget =>
  track === 'internal' ? 'staging' : 'production';

const addCheck = (
  checks: ReleaseCheck[],
  name: string,
  status: ReleaseCheckStatus,
  detail: string,
): void => {
  checks.push({ name, status, detail });
};

const securePolicyUrl = (value: string | undefined): ReleaseCheckStatus => {
  if (value === undefined) return 'missing';
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      return 'invalid';
    }
    return 'unverified';
  } catch {
    return 'invalid';
  }
};

const environmentCheck = (report: EnvironmentPreflightReport): ReleaseCheckStatus => {
  if (report.status === 'blocked') return 'blocked';
  return report.status === 'partial' ? 'unverified' : 'ok';
};

const configuredBoolean = (env: EnvironmentValues, name: string): boolean =>
  ['1', 'true', 'on', 'enabled'].includes((valueFor(env, name) ?? '').toLowerCase());

const evidenceCheck = (name: string, detail: string): ReleaseCheck => ({
  name,
  status: 'unverified',
  detail,
});

const addExternalEvidence = (
  checks: ReleaseCheck[],
  track: ReleaseTrack,
  env: EnvironmentValues,
  mobile: MobileReleaseMetadata,
): void => {
  checks.push(
    evidenceCheck(
      'TESTFLIGHT_BUILD',
      'EAS build status and the uploaded artifact require external evidence',
    ),
    evidenceCheck(
      'APPLE_SIGNING',
      'Apple team, certificate, and provisioning require external evidence',
    ),
    evidenceCheck(
      'REAL_DEVICE',
      'real-device launch and permission evidence require external evidence',
    ),
    evidenceCheck(
      'PACKAGE_BOUNDARY',
      'run the repository architecture/build gates and review the produced bundle separately',
    ),
  );

  const attestReady =
    valueFor(env, 'APP_ATTEST_MODE') === 'required' &&
    valueFor(env, 'APP_ATTEST_ENVIRONMENT') === 'production';
  addCheck(
    checks,
    'APP_ATTEST_EVIDENCE',
    track === 'external' && !attestReady ? 'blocked' : 'unverified',
    track === 'external'
      ? attestReady
        ? 'configuration is present; Apple verifier and real-device replay evidence are still required'
        : 'external distribution requires APP_ATTEST_MODE=required and APP_ATTEST_ENVIRONMENT=production'
      : 'internal distribution follows the existing staging preflight; external App Attest evidence is a separate gate',
  );

  const journeyConfigured = configuredBoolean(env, 'IMA_PROVIDER_LAST_TRAIN');
  addCheck(
    checks,
    'REAL_JOURNEY_EVIDENCE',
    journeyConfigured ? 'unverified' : 'blocked',
    journeyConfigured
      ? 'configuration is present; verified source, freshness, and rollback evidence are still required'
      : 'M33 verified last-train data is required; missing data must remain disabled',
  );

  const liveMode = valueFor(env, 'IMA_RUNTIME_MODE') === 'live';
  for (const name of [
    'IMA_PROVIDER_OPENAI',
    'IMA_PROVIDER_PLACES',
    'IMA_PROVIDER_ROUTES',
  ] as const) {
    addCheck(
      checks,
      name,
      configuredBoolean(env, name) ? 'unverified' : 'blocked',
      configuredBoolean(env, name)
        ? 'capability is requested; runtime wiring and live permission still require evidence'
        : 'required TestFlight capability flag is disabled or missing',
    );
  }
  addCheck(
    checks,
    'PHOTO_CAPABILITY',
    configuredBoolean(env, 'IMA_PROVIDER_PLACES') &&
      valueFor(env, 'PHOTO_TOKEN_SECRET') !== undefined
      ? 'unverified'
      : 'blocked',
    configuredBoolean(env, 'IMA_PROVIDER_PLACES') &&
      valueFor(env, 'PHOTO_TOKEN_SECRET') !== undefined
      ? 'photo admission is configured; rendered attribution and live provider evidence are still required'
      : 'photo delivery requires Places admission and PHOTO_TOKEN_SECRET',
  );
  addCheck(
    checks,
    'LIVE_PROVIDER_EVIDENCE',
    liveMode ? 'unverified' : 'blocked',
    liveMode
      ? 'M35 live API, account permission, attribution, and cost evidence are still required'
      : 'a TestFlight release cannot use fixture or disabled provider mode',
  );

  const inviteConsent = valueFor(env, 'IMA_TESTFLIGHT_INVITE_CONFIRM');
  addCheck(
    checks,
    'INVITE_CONSENT',
    inviteConsent === 'YES' ? 'unverified' : inviteConsent === undefined ? 'missing' : 'invalid',
    inviteConsent === 'YES'
      ? 'operator confirmation is recorded; invitations remain a manual user-authorized action'
      : 'explicit YES is required before inviting any tester',
  );

  addCheck(
    checks,
    'SHARE_EVENT_PATH',
    'unverified',
    'OS Share Sheet or a configured share scheme may be used; share/events behavior and permission require evidence',
  );

  addCheck(
    checks,
    'PRIVACY_DATA_LIFECYCLE',
    'unverified',
    'data sent, retention, deletion, and user-request handling require review evidence',
  );
  addCheck(
    checks,
    'PRIVACY_DEVICE_LIST',
    'unverified',
    'on-device saved-place data can be lost with device or app deletion; recovery and user messaging require evidence',
  );
  addCheck(
    checks,
    'FONT_LICENSE_ATTRIBUTION',
    'unverified',
    'font licenses and provider attribution in the shipped UI require review evidence',
  );

  if (track === 'external') {
    addCheck(
      checks,
      'EXTERNAL_PRODUCTION_FLAGS',
      valueFor(env, 'IMA_RUNTIME_FLAGS_CONNECTED') === '1' ? 'unverified' : 'blocked',
      valueFor(env, 'IMA_RUNTIME_FLAGS_CONNECTED') === '1'
        ? 'environment declaration cannot prove runtime flag wiring'
        : 'external distribution needs a separately verified production runtime flag gate',
    );
  }

  addCheck(
    checks,
    'PRIVACY_POLICY_HOSTING',
    securePolicyUrl(mobile.privacyPolicyUrl),
    securePolicyUrl(mobile.privacyPolicyUrl) === 'unverified'
      ? 'HTTPS URL format is valid; hosted policy and App Store metadata still require review'
      : 'a public HTTPS privacy policy URL is required',
  );
  addCheck(
    checks,
    'LOCATION_PERMISSION',
    mobile.locationPermissionConfigured ? 'ok' : 'missing',
    mobile.locationPermissionConfigured
      ? 'NSLocationWhenInUseUsageDescription is present in the mobile config'
      : 'the iOS location usage description is missing',
  );
  addCheck(
    checks,
    'PROVIDER_ATTRIBUTION',
    mobile.attributionPolicyDocumentPresent ? 'unverified' : 'missing',
    mobile.attributionPolicyDocumentPresent
      ? 'local policy documentation exists; provider account permission and rendered attribution require review'
      : 'provider attribution policy documentation is missing',
  );
  const qualityScope = mobile.qualityScope;
  addCheck(
    checks,
    'QUALITY_SCOPE',
    qualityScope === 'ebisu-daikanyama' ? 'ok' : qualityScope === undefined ? 'missing' : 'invalid',
    qualityScope === 'ebisu-daikanyama'
      ? 'Ebisu and Daikanyama are a quality-evaluation scope, not a geographic hard lock'
      : 'set IMA_RELEASE_QUALITY_SCOPE=ebisu-daikanyama; hard geographic locks are not allowed',
  );
  addCheck(
    checks,
    'MOBILE_SECRET_BOUNDARY',
    mobile.secretFreeConfig ? 'unverified' : 'blocked',
    mobile.secretFreeConfig
      ? 'static mobile config scan found no secret literal; the built bundle still requires review'
      : 'provider and Worker secrets must not be present in the mobile bundle configuration',
  );
};

export const preflightRelease = (
  track: ReleaseTrack,
  env: EnvironmentValues,
  mobile: MobileReleaseMetadata,
): ReleasePreflightReport => {
  const target = targetFor(track);
  const environment = preflightEnvironment(target, {
    ...env,
    IMA_PREFLIGHT_BUILD: '1',
    ...(track === 'external' ? { IMA_PREFLIGHT_DEPLOY: '1' } : {}),
  });
  const checks: ReleaseCheck[] = [];
  addCheck(
    checks,
    'ENVIRONMENT_PREFLIGHT',
    environmentCheck(environment),
    'existing environment preflight result',
  );
  addExternalEvidence(checks, track, env, mobile);

  const hasBlockingCheck = checks.some(({ status }) =>
    ['missing', 'invalid', 'blocked'].includes(status),
  );
  const hasUnverifiedCheck = checks.some(({ status }) => status === 'unverified');
  const status: ReleaseStatus = hasBlockingCheck
    ? 'blocked'
    : hasUnverifiedCheck
      ? 'partial'
      : 'ready';
  return {
    track,
    target,
    status,
    localChecksReady: !hasBlockingCheck,
    externalEvidenceVerified: false,
    releaseAllowed: false,
    environment,
    checks,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasSecretLikeConfig = (value: unknown, key = ''): boolean => {
  if (typeof value === 'string') {
    return (
      key !== '' && /(api[_-]?key|token|secret|password)/iu.test(key) && value.trim().length > 0
    );
  }
  if (Array.isArray(value)) return value.some((entry) => hasSecretLikeConfig(entry, key));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([entryKey, entryValue]) =>
    hasSecretLikeConfig(entryValue, entryKey),
  );
};

export const mobileReleaseMetadataFromConfig = (
  config: unknown,
  env: EnvironmentValues,
  attributionPolicyDocumentPresent: boolean,
): MobileReleaseMetadata => {
  const expo = isRecord(config) && isRecord(config.expo) ? config.expo : {};
  const ios = isRecord(expo.ios) ? expo.ios : {};
  const infoPlist = isRecord(ios.infoPlist) ? ios.infoPlist : {};
  const locationDescription = infoPlist.NSLocationWhenInUseUsageDescription;
  return {
    privacyPolicyUrl: valueFor(env, 'EXPO_PUBLIC_PRIVACY_POLICY_URL'),
    locationPermissionConfigured:
      typeof locationDescription === 'string' && locationDescription.trim().length > 0,
    attributionPolicyDocumentPresent,
    qualityScope: valueFor(env, 'IMA_RELEASE_QUALITY_SCOPE'),
    secretFreeConfig: !hasSecretLikeConfig(config),
  };
};

const trackFromArgs = (args: readonly string[]): ReleaseTrack | null => {
  const index = args.indexOf('--track');
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === 'internal' || value === 'external' ? value : null;
};

export const runReleasePreflightCli = (
  args: readonly string[],
  env: EnvironmentValues,
  write: (line: string) => void,
  config: unknown = undefined,
  attributionPolicyDocumentPresent = false,
): 0 | 1 | 2 => {
  const track = trackFromArgs(args);
  if (track === null) {
    write(JSON.stringify({ status: 'blocked', code: 'TRACK_REQUIRED' }));
    return 1;
  }
  const mobile = mobileReleaseMetadataFromConfig(config, env, attributionPolicyDocumentPresent);
  const report = preflightRelease(track, env, mobile);
  write(JSON.stringify(report));
  return report.status === 'ready' ? 0 : report.status === 'partial' ? 2 : 1;
};

if (process.argv[1]?.endsWith('/scripts/release-preflight.ts') === true) {
  const configPath = resolve(process.cwd(), 'apps/mobile/app.json');
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch {
    config = undefined;
  }
  process.exitCode = runReleasePreflightCli(
    process.argv.slice(2),
    process.env,
    console.log,
    config,
    existsSync(resolve(process.cwd(), 'docs/design/provider-policy.md')),
  );
}
