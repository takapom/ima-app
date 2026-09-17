import {
  createAppIntegrityGate,
  resolveAppIntegrityPolicy,
  type AppAttestEnvironment,
  type AppIntegrityGate,
  type AppIntegrityVerifier,
} from '@worker/security/app-integrity';
import {
  createDurableAppIntegrityStores,
  type AppIntegrityNamespace,
} from '@worker/adapters/outbound/persistence/security/app-integrity-do';

type BootstrapAppIntegrityEnv = {
  readonly APP_INTEGRITY?: AppIntegrityNamespace;
  readonly IMA_ENV?: string;
  readonly APP_ATTEST_ENVIRONMENT?: string;
  readonly APP_ATTEST_MODE?: string;
};

const isStoreEnvironment = (
  value: AppAttestEnvironment,
): value is Exclude<AppAttestEnvironment, 'unknown'> =>
  value === 'development' || value === 'production';

/**
 * Compose the HTTP gate at the bootstrap boundary. A verifier is deliberately
 * required before a durable store is attached, so an unconfigured runtime
 * cannot issue usable challenges or appear App Attest-ready by accident.
 */
export const createBootstrapAppIntegrityGate = (
  env: BootstrapAppIntegrityEnv,
  verifier?: AppIntegrityVerifier,
): AppIntegrityGate => {
  const policy = resolveAppIntegrityPolicy({
    ...(env.IMA_ENV === undefined ? {} : { deploymentEnvironment: env.IMA_ENV }),
    ...(env.APP_ATTEST_ENVIRONMENT === undefined
      ? {}
      : { environment: env.APP_ATTEST_ENVIRONMENT }),
    ...(env.APP_ATTEST_MODE === undefined ? {} : { enforcement: env.APP_ATTEST_MODE }),
  });
  if (
    verifier === undefined ||
    env.APP_INTEGRITY === undefined ||
    !isStoreEnvironment(policy.environment)
  ) {
    return createAppIntegrityGate({
      ...policy,
      ...(verifier === undefined ? {} : { verifier }),
    });
  }
  return createAppIntegrityGate({
    ...policy,
    ...createDurableAppIntegrityStores(env.APP_INTEGRITY, policy.environment),
    verifier,
  });
};
