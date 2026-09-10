import type { ConfigContext, ExpoConfig } from 'expo/config';

export type MobileConfigEnvironment = Readonly<Record<string, string | undefined>>;

const PLACEHOLDER = /^(?:replace-me|change-me|todo|<[^>]+>)$/iu;
const BUNDLE_IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*\.)+[A-Za-z0-9-]+$/u;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ENVIRONMENTS = ['dev', 'staging', 'production'] as const;
type MobileEnvironment = (typeof ENVIRONMENTS)[number];

const valueFor = (env: MobileConfigEnvironment, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};

const usable = (value: string | undefined): value is string =>
  value !== undefined && !PLACEHOLDER.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMobileEnvironment = (value: string): value is MobileEnvironment =>
  ENVIRONMENTS.some((candidate) => candidate === value);

const environmentFor = (env: MobileConfigEnvironment): MobileEnvironment => {
  const environment = valueFor(env, 'EXPO_PUBLIC_ENVIRONMENT') ?? 'dev';
  if (!isMobileEnvironment(environment)) {
    throw new Error('EXPO_PUBLIC_ENVIRONMENT must be dev, staging, or production');
  }
  return environment;
};

const requiresExternalIdentity = (env: MobileConfigEnvironment): boolean =>
  environmentFor(env) !== 'dev' || valueFor(env, 'EAS_BUILD') === 'true';

const requireSecureExternalEndpoint = (env: MobileConfigEnvironment): void => {
  if (environmentFor(env) === 'dev') return;
  const endpoint = valueFor(env, 'EXPO_PUBLIC_API_BASE_URL');
  if (endpoint === undefined) {
    throw new Error('Staging and production builds require EXPO_PUBLIC_API_BASE_URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('EXPO_PUBLIC_API_BASE_URL must be a URL for staging or production');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  ) {
    throw new Error(
      'EXPO_PUBLIC_API_BASE_URL must be a non-local HTTPS URL without credentials for staging or production',
    );
  }
};

export const createMobileConfig = (
  config: Partial<ExpoConfig>,
  env: MobileConfigEnvironment,
): Partial<ExpoConfig> => {
  const bundleIdentifier = valueFor(env, 'EXPO_IOS_BUNDLE_IDENTIFIER');
  const projectId = valueFor(env, 'EAS_PROJECT_ID');
  const needsIdentity = requiresExternalIdentity(env);

  requireSecureExternalEndpoint(env);

  if (bundleIdentifier !== undefined && !BUNDLE_IDENTIFIER.test(bundleIdentifier)) {
    throw new Error('EXPO_IOS_BUNDLE_IDENTIFIER must be a reverse-DNS identifier');
  }
  if (projectId !== undefined && !PROJECT_ID.test(projectId)) {
    throw new Error('EAS_PROJECT_ID must be a UUID');
  }
  if (needsIdentity && (!usable(bundleIdentifier) || !usable(projectId))) {
    throw new Error(
      'External iOS builds require EXPO_IOS_BUNDLE_IDENTIFIER and EAS_PROJECT_ID from the build environment',
    );
  }

  const extraValue: unknown = config.extra;
  const currentExtra = isRecord(extraValue) ? extraValue : {};
  const currentEas = isRecord(currentExtra.eas) ? currentExtra.eas : {};

  return {
    ...config,
    ...(bundleIdentifier === undefined ? {} : { ios: { ...config.ios, bundleIdentifier } }),
    ...(projectId === undefined
      ? {}
      : { extra: { ...currentExtra, eas: { ...currentEas, projectId } } }),
  };
};

export default ({ config }: ConfigContext): Partial<ExpoConfig> =>
  createMobileConfig(config, process.env);
