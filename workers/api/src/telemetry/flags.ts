import * as v from 'valibot';

export const OperationalFlagsSchema = v.strictObject({
  mode: v.picklist(['live', 'fixture', 'disabled']),
  places: v.boolean(),
  hotpepper: v.boolean(),
  lastTrain: v.boolean(),
  routes: v.boolean(),
  openai: v.boolean(),
  shareLineScheme: v.boolean(),
  killSwitch: v.boolean(),
  qualityEnvelope: v.boolean(),
});
export type OperationalFlags = v.InferOutput<typeof OperationalFlagsSchema>;
export type OperationalMode = OperationalFlags['mode'];

export const OPERATIONAL_FLAG_ENV = Object.freeze({
  mode: 'IMA_RUNTIME_MODE',
  places: 'IMA_PROVIDER_PLACES',
  hotpepper: 'IMA_PROVIDER_HOTPEPPER',
  lastTrain: 'IMA_PROVIDER_LAST_TRAIN',
  routes: 'IMA_PROVIDER_ROUTES',
  openai: 'IMA_PROVIDER_OPENAI',
  shareLineScheme: 'IMA_SHARE_LINE_SCHEME',
  killSwitch: 'IMA_KILL_SWITCH',
  qualityEnvelope: 'IMA_QUALITY_ENVELOPE',
} as const);

export type OperationalFlagName =
  | 'places'
  | 'hotpepper'
  | 'lastTrain'
  | 'routes'
  | 'openai'
  | 'shareLineScheme'
  | 'qualityEnvelope';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const textValue = (env: unknown, key: string): string | undefined => {
  const value = isRecord(env) ? env[key] : undefined;
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
};

const modeValue = (env: unknown): OperationalMode => {
  const value = textValue(env, OPERATIONAL_FLAG_ENV.mode);
  return value === 'live' || value === 'fixture' || value === 'disabled' ? value : 'disabled';
};

const booleanValue = (env: unknown, key: string): boolean => {
  const value = textValue(env, key);
  return value === '1' || value === 'true' || value === 'on' || value === 'enabled';
};

/**
 * Resolves flags from explicit Worker configuration. Missing or malformed values are disabled;
 * the resolver never turns a live request into a fixture request.
 */
export const resolveOperationalFlags = (env: unknown): OperationalFlags => {
  const flags = {
    mode: modeValue(env),
    places: booleanValue(env, OPERATIONAL_FLAG_ENV.places),
    hotpepper: booleanValue(env, OPERATIONAL_FLAG_ENV.hotpepper),
    lastTrain: booleanValue(env, OPERATIONAL_FLAG_ENV.lastTrain),
    routes: booleanValue(env, OPERATIONAL_FLAG_ENV.routes),
    openai: booleanValue(env, OPERATIONAL_FLAG_ENV.openai),
    shareLineScheme: booleanValue(env, OPERATIONAL_FLAG_ENV.shareLineScheme),
    killSwitch: booleanValue(env, OPERATIONAL_FLAG_ENV.killSwitch),
    qualityEnvelope: booleanValue(env, OPERATIONAL_FLAG_ENV.qualityEnvelope),
  };
  return v.parse(OperationalFlagsSchema, flags);
};

export const operationalFlagEnabled = (
  flags: OperationalFlags,
  name: OperationalFlagName,
): boolean => flags.mode !== 'disabled' && !flags.killSwitch && flags[name];

export const operationalCapabilityMode = (
  flags: OperationalFlags,
  name: OperationalFlagName,
): OperationalMode => (operationalFlagEnabled(flags, name) ? flags.mode : 'disabled');
