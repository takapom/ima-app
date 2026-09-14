export type DeploymentTarget = 'dev' | 'staging' | 'production';
export type ProviderMode = 'fixture' | 'live' | 'disabled';
export type PreflightStatus = 'ready' | 'partial' | 'blocked';
export type PreflightCheckStatus = 'ok' | 'missing' | 'invalid' | 'blocked' | 'unverified';

export type EnvironmentValues = Readonly<Record<string, string | undefined>>;

export type PreflightCheck = {
  readonly name: string;
  readonly status: PreflightCheckStatus;
  readonly detail: string;
};

export type EnvironmentPreflightReport = {
  readonly target: DeploymentTarget;
  readonly mode: ProviderMode | null;
  readonly status: PreflightStatus;
  /** Configuration cannot prove that the production composition is connected. */
  readonly runtimeVerified: false;
  readonly runnable: boolean;
  readonly deployAllowed: boolean;
  readonly buildRequested: boolean;
  readonly deployRequested: boolean;
  readonly checks: readonly PreflightCheck[];
};

const TARGETS: readonly DeploymentTarget[] = ['dev', 'staging', 'production'];
const MODES: readonly ProviderMode[] = ['fixture', 'live', 'disabled'];
const LIVE_CONFIRMATIONS = [
  'IMA_PROVIDER_LIVE_CONFIRM',
  'IMA_PROVIDER_BILLING_CONFIRM',
  'IMA_PROVIDER_PERMISSION_CONFIRM',
] as const;
const LIVE_SECRETS = ['OPENAI_API_KEY', 'HOTPEPPER_API_KEY', 'PLACES_CURSOR_SECRET'] as const;

const valueFor = (env: EnvironmentValues, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};

const placeholder = (value: string): boolean =>
  /^(?:replace-me|change-me|todo|<[^>]+>)$/iu.test(value.trim());

const hasUsableValue = (env: EnvironmentValues, name: string): boolean => {
  const value = valueFor(env, name);
  return value !== undefined && !placeholder(value);
};

const isTarget = (value: string | undefined): value is DeploymentTarget =>
  value !== undefined && TARGETS.includes(value as DeploymentTarget);

const parseMode = (value: string | undefined): ProviderMode | null =>
  value !== undefined && MODES.includes(value as ProviderMode) ? (value as ProviderMode) : null;

const requested = (env: EnvironmentValues, name: string): boolean => valueFor(env, name) === '1';

const endpointStatus = (
  target: DeploymentTarget,
  endpoint: string | undefined,
): { readonly status: PreflightCheckStatus; readonly detail: string } => {
  if (endpoint === undefined)
    return { status: 'missing', detail: 'API endpoint is not configured' };
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { status: 'invalid', detail: 'API endpoint is not a URL' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { status: 'invalid', detail: 'API endpoint must not contain credentials' };
  }
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (target === 'dev') {
    return parsed.protocol === 'http:' && localHost
      ? { status: 'ok', detail: 'local HTTP endpoint' }
      : { status: 'invalid', detail: 'dev endpoint must use localhost HTTP' };
  }
  return parsed.protocol === 'https:' && !localHost
    ? { status: 'ok', detail: 'non-local HTTPS endpoint' }
    : { status: 'invalid', detail: 'staging/production endpoint must use non-local HTTPS' };
};

const addCheck = (
  checks: PreflightCheck[],
  name: string,
  status: PreflightCheckStatus,
  detail: string,
): void => {
  checks.push({ name, status, detail });
};

export const preflightEnvironment = (
  target: DeploymentTarget,
  env: EnvironmentValues,
): EnvironmentPreflightReport => {
  const checks: PreflightCheck[] = [];
  const configuredTarget = valueFor(env, 'IMA_ENV');
  const mode = parseMode(valueFor(env, 'IMA_RUNTIME_MODE'));
  const buildRequested = requested(env, 'IMA_PREFLIGHT_BUILD');
  const deployRequested = requested(env, 'IMA_PREFLIGHT_DEPLOY');

  addCheck(
    checks,
    'IMA_ENV',
    configuredTarget === target ? 'ok' : configuredTarget === undefined ? 'missing' : 'invalid',
    configuredTarget === target ? 'target matches' : 'environment target must match --target',
  );
  addCheck(
    checks,
    'IMA_RUNTIME_MODE',
    mode === null
      ? valueFor(env, 'IMA_RUNTIME_MODE') === undefined
        ? 'missing'
        : 'invalid'
      : 'ok',
    mode === null ? 'mode must be fixture, live, or disabled' : `${mode} mode selected`,
  );
  addCheck(
    checks,
    'APP_TOKEN',
    hasUsableValue(env, 'APP_TOKEN')
      ? 'ok'
      : valueFor(env, 'APP_TOKEN') === undefined
        ? 'missing'
        : 'invalid',
    hasUsableValue(env, 'APP_TOKEN') ? 'configured' : 'APP_TOKEN is missing or placeholder',
  );

  const endpoint = valueFor(env, 'EXPO_PUBLIC_API_BASE_URL') ?? valueFor(env, 'API_BASE_URL');
  const endpointResult = endpointStatus(target, endpoint);
  addCheck(checks, 'EXPO_PUBLIC_API_BASE_URL', endpointResult.status, endpointResult.detail);

  if (target !== 'dev' && mode === 'fixture') {
    addCheck(
      checks,
      'PRODUCTION_FIXTURE_BYPASS',
      'blocked',
      'fixture mode cannot be deployed to staging or production',
    );
  }

  if (mode === 'live') {
    for (const name of LIVE_CONFIRMATIONS) {
      addCheck(
        checks,
        name,
        valueFor(env, name) === 'YES'
          ? 'ok'
          : valueFor(env, name) === undefined
            ? 'missing'
            : 'invalid',
        valueFor(env, name) === 'YES' ? 'explicit operator confirmation' : 'must be exactly YES',
      );
    }
    for (const name of LIVE_SECRETS) {
      addCheck(
        checks,
        name,
        hasUsableValue(env, name)
          ? 'ok'
          : valueFor(env, name) === undefined
            ? 'missing'
            : 'invalid',
        hasUsableValue(env, name) ? 'configured' : 'required for live provider mode',
      );
    }
  }

  const attestMode = valueFor(env, 'APP_ATTEST_MODE');
  const attestEnvironment = valueFor(env, 'APP_ATTEST_ENVIRONMENT');
  if (target !== 'dev') {
    addCheck(
      checks,
      'APP_ATTEST_MODE',
      attestMode === undefined ? 'missing' : attestMode === 'required' ? 'unverified' : 'blocked',
      attestMode === undefined
        ? 'external targets require APP_ATTEST_MODE=required; #28 is not connected yet'
        : attestMode === 'required'
          ? 'configuration is present, but #28 App Attest integration is not verified'
          : 'external targets reject disabled/internal App Attest enforcement',
    );
    addCheck(
      checks,
      'APP_ATTEST_ENVIRONMENT',
      attestEnvironment === undefined
        ? 'missing'
        : attestEnvironment === 'production'
          ? 'unverified'
          : 'invalid',
      attestEnvironment === undefined
        ? 'external targets require APP_ATTEST_ENVIRONMENT=production'
        : attestEnvironment === 'production'
          ? 'Apple environment is present, but #28 App Attest integration is not verified'
          : 'external targets require APP_ATTEST_ENVIRONMENT=production',
    );
    addCheck(
      checks,
      'IMA_RUNTIME_FLAGS_CONNECTED',
      'unverified',
      '#27 runtime flag wiring cannot be established by an environment variable',
    );
  }

  if (buildRequested) {
    for (const name of ['EAS_PROJECT_ID', 'EXPO_IOS_BUNDLE_IDENTIFIER'] as const) {
      addCheck(
        checks,
        name,
        hasUsableValue(env, name)
          ? 'ok'
          : valueFor(env, name) === undefined
            ? 'missing'
            : 'invalid',
        hasUsableValue(env, name) ? 'configured' : 'required for an iOS build',
      );
    }
  }

  if (deployRequested) {
    for (const name of [
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_WORKER_ROUTE',
    ] as const) {
      addCheck(
        checks,
        name,
        hasUsableValue(env, name)
          ? 'ok'
          : valueFor(env, name) === undefined
            ? 'missing'
            : 'invalid',
        hasUsableValue(env, name) ? 'configured' : 'required for a deploy preflight',
      );
    }
    addCheck(
      checks,
      'IMA_DEPLOY_CONFIRM',
      valueFor(env, 'IMA_DEPLOY_CONFIRM') === 'YES'
        ? 'ok'
        : valueFor(env, 'IMA_DEPLOY_CONFIRM') === undefined
          ? 'missing'
          : 'invalid',
      'deploy requires an explicit operator confirmation',
    );
  }

  const hasBlockingCheck = checks.some(({ status }) =>
    ['missing', 'invalid', 'blocked'].includes(status),
  );
  const hasUnverifiedCheck = checks.some(({ status }) => status === 'unverified');
  const status: PreflightStatus = hasBlockingCheck
    ? 'blocked'
    : hasUnverifiedCheck
      ? 'partial'
      : 'ready';
  // The environment file is not evidence that the Worker factory is wired. Keep
  // configuration readiness separate from an executable runtime until a Worker
  // smoke test records that composition. Never accept a self-asserted env flag.
  const runtimeVerified = false;
  const runnable = runtimeVerified && status === 'ready' && mode !== null && mode !== 'disabled';
  const deployAllowed =
    runtimeVerified &&
    status === 'ready' &&
    deployRequested &&
    (target === 'dev' || mode === 'live') &&
    mode !== 'fixture';
  return {
    target,
    mode,
    status,
    runtimeVerified,
    runnable,
    deployAllowed,
    buildRequested,
    deployRequested,
    checks,
  };
};

const targetFromArgs = (
  args: readonly string[],
  env: EnvironmentValues,
): DeploymentTarget | null => {
  const index = args.indexOf('--target');
  const value = index >= 0 ? args[index + 1] : valueFor(env, 'IMA_ENV');
  return isTarget(value) ? value : null;
};

export const runEnvironmentPreflightCli = (
  args: readonly string[],
  env: EnvironmentValues,
  write: (line: string) => void,
): 0 | 1 | 2 => {
  const target = targetFromArgs(args, env);
  if (target === null) {
    write(JSON.stringify({ status: 'blocked', code: 'TARGET_REQUIRED' }));
    return 1;
  }
  const report = preflightEnvironment(target, env);
  write(JSON.stringify(report));
  return report.status === 'ready' ? 0 : report.status === 'partial' ? 2 : 1;
};

if (process.argv[1]?.endsWith('/scripts/environment-preflight.ts') === true) {
  process.exitCode = runEnvironmentPreflightCli(process.argv.slice(2), process.env, console.log);
}
