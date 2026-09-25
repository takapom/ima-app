import type {
  AppAttestEnvironment,
  AppIntegrityEnforcement,
  AppIntegrityPolicy,
} from '@worker/application/ports/app-integrity';
export const resolveAppIntegrityPolicy = (input: {
  readonly deploymentEnvironment?: string;
  readonly environment?: string;
  readonly enforcement?: string;
}): AppIntegrityPolicy => {
  const external =
    input.deploymentEnvironment !== undefined && input.deploymentEnvironment !== 'dev';
  const environment: AppAttestEnvironment =
    input.environment === 'production'
      ? 'production'
      : input.environment === 'development' && !external
        ? 'development'
        : input.environment === undefined || input.environment === ''
          ? external
            ? 'unknown'
            : 'development'
          : 'unknown';
  const explicit = input.enforcement;
  const enforcement: AppIntegrityEnforcement =
    external && explicit !== 'required'
      ? 'required'
      : explicit === 'disabled'
        ? 'disabled'
        : explicit === 'internal'
          ? 'internal'
          : explicit === 'required'
            ? 'required'
            : environment === 'production' || environment === 'unknown'
              ? 'required'
              : explicit === undefined || explicit === ''
                ? 'internal'
                : 'required';
  return { enforcement, environment };
};
