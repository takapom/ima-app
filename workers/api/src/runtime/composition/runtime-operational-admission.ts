import {
  googlePlacesApiKey,
  placesCursorSecret,
  productionSecret,
} from './runtime-production-support';
import { isConfiguredSecret } from './runtime-production-provider-config';
import { resolveRuntimeOperationalGate } from './runtime-operational-gate';

export type RuntimeOperationalAdmissionInput = {
  readonly env: unknown;
  readonly hasPrepareTurn: boolean;
  readonly hasModelOverride: boolean;
  readonly hasFetcher: boolean;
  readonly placesRequested: boolean;
  readonly routesRequested: boolean;
  readonly photosRequested: boolean;
  readonly googlePlacesApiKeyOverride?: string;
  readonly placesCursorSecretOverride?: string;
  readonly googleRoutesApiKeyOverride?: string;
};

export type RuntimeOperationalAdmission = {
  readonly placesEnabled: boolean;
  readonly routesEnabled: boolean;
  readonly lastTrainEnabled: boolean;
  readonly photosEnabled: boolean;
  readonly googlePlacesApiKey?: string;
  readonly placesCursorSecret?: string;
  readonly googleRoutesApiKey?: string;
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
    ((operational.enabled('places') && input.placesRequested) ||
      (operational.enabled('routes') && input.routesRequested))
  ) {
    return undefined;
  }

  const placesKey = input.googlePlacesApiKeyOverride ?? googlePlacesApiKey(input.env);
  const cursorSecret = input.placesCursorSecretOverride ?? placesCursorSecret(input.env);
  const routesKey =
    input.googleRoutesApiKeyOverride ?? productionSecret(input.env, 'GOOGLE_ROUTES_API_KEY');
  const placesEnabled = operational.enabled('places') && input.placesRequested;
  const routesEnabled = operational.enabled('routes') && input.routesRequested;
  const lastTrainEnabled = operational.enabled('lastTrain');
  const photosEnabled = operational.enabled('places') && input.photosRequested;
  const openAiKey = isConfiguredSecret(productionSecret(input.env, 'OPENAI_API_KEY'));
  const modelReady = openAiKey || (operational.mode === 'fixture' && input.hasModelOverride);
  const portsReady =
    input.hasPrepareTurn ||
    !placesEnabled ||
    (isConfiguredSecret(placesKey) && isConfiguredSecret(cursorSecret));
  if (!modelReady || !portsReady) return undefined;

  return {
    placesEnabled,
    routesEnabled,
    lastTrainEnabled,
    photosEnabled,
    ...(isConfiguredSecret(placesKey) ? { googlePlacesApiKey: placesKey } : {}),
    ...(isConfiguredSecret(cursorSecret) ? { placesCursorSecret: cursorSecret } : {}),
    ...(isConfiguredSecret(routesKey) ? { googleRoutesApiKey: routesKey } : {}),
  };
};
