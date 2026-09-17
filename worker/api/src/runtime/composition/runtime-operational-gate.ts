import {
  operationalCapabilityMode,
  resolveOperationalFlags,
  type OperationalFlagName,
  type OperationalFlags,
  type OperationalMode,
} from '@api/telemetry/flags';

/** Provider capabilities which can initiate an external or paid operation. */
export type RuntimeProviderCapability = Exclude<
  OperationalFlagName,
  'shareLineScheme' | 'qualityEnvelope'
>;

export type RuntimeOperationalGate = {
  readonly flags: OperationalFlags;
  readonly mode: OperationalMode;
  readonly modeFor: (capability: RuntimeProviderCapability) => OperationalMode;
  readonly enabled: (capability: RuntimeProviderCapability) => boolean;
};

/**
 * Resolves the host-owned provider admission once per Worker composition.
 *
 * Missing or malformed values are already fail-closed in the flags resolver. This wrapper keeps
 * the same decision in one object so HTTP/bootstrap and the production runtime cannot silently
 * choose a fixture implementation when live configuration is unavailable.
 */
export const resolveRuntimeOperationalGate = (env: unknown): RuntimeOperationalGate => {
  const flags = resolveOperationalFlags(env);
  return {
    flags,
    mode: flags.mode,
    modeFor: (capability) => operationalCapabilityMode(flags, capability),
    enabled: (capability) => operationalCapabilityMode(flags, capability) !== 'disabled',
  };
};
