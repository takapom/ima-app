import {
  placesCursorSecret,
  productionSecret,
} from '@worker/composition/runtime-production-support';
import { isConfiguredSecret } from '@worker/composition/runtime-production-provider-config';
import { resolveRuntimeOperationalGate } from '@worker/composition/runtime-operational-gate';

export type RuntimeOperationalAdmissionInput = {
  readonly env: unknown;
  readonly hasPrepareTurn: boolean;
  readonly hasModelOverride: boolean;
  readonly hasFetcher: boolean;
  readonly placesRequested: boolean;
  readonly hotPepperApiKeyOverride?: string;
  readonly placesCursorSecretOverride?: string;
};

export type RuntimeOperationalAdmission = {
  readonly placesEnabled: boolean;
  readonly hotPepperApiKey?: string;
  readonly placesCursorSecret?: string;
};

/**
 * Performs the last fail-closed check before the production provider graph is built.
 * Fixture mode may use injected model/fetcher dependencies, but never global live clients.
 */
export const resolveRuntimeOperationalAdmission = (
  input: RuntimeOperationalAdmissionInput,
): RuntimeOperationalAdmission | undefined => {
  const operational = resolveRuntimeOperationalGate(input.env);
  if (!operational.enabled('openai')) return undefined;
  if (operational.mode === 'fixture' && !input.hasModelOverride) return undefined;
  if (
    operational.mode === 'fixture' &&
    !input.hasPrepareTurn &&
    !input.hasFetcher &&
    operational.enabled('hotpepper') &&
    input.placesRequested
  ) {
    return undefined;
  }

  const placesKey =
    input.hotPepperApiKeyOverride ?? productionSecret(input.env, 'HOTPEPPER_API_KEY');
  const cursorSecret = input.placesCursorSecretOverride ?? placesCursorSecret(input.env);
  const placesEnabled = operational.enabled('hotpepper') && input.placesRequested;
  const openAiKey = isConfiguredSecret(productionSecret(input.env, 'OPENAI_API_KEY'));
  const modelReady = openAiKey || (operational.mode === 'fixture' && input.hasModelOverride);
  const portsReady =
    input.hasPrepareTurn ||
    !placesEnabled ||
    (isConfiguredSecret(placesKey) && isConfiguredSecret(cursorSecret));
  if (!modelReady || !portsReady) return undefined;

  return {
    placesEnabled,
    ...(isConfiguredSecret(placesKey) ? { hotPepperApiKey: placesKey } : {}),
    ...(isConfiguredSecret(cursorSecret) ? { placesCursorSecret: cursorSecret } : {}),
  };
};
