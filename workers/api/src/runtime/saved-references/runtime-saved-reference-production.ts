import type { HarnessContext, ToolExecutionContext } from '@ima/core';
import {
  createOwnerSavedReferenceRpc,
  type SavedReferenceNamespace,
} from '../../saved-references/saved-reference-rpc';
import type {
  SavedReferenceCandidateRegistry,
  SavedReferenceDetailsHandoff,
} from '../../providers/places-details/handoff';
import type { GooglePlaceDetailsTransport } from '../../providers/places-details/types';
import {
  createHandoffAwareSavedResolver,
  createHandoffCandidateRegistry,
  createSavedReferenceDetailsHandoff,
  createSavedReferenceGoogleProvider,
} from './runtime-saved-reference-handoff';
import {
  createSavedPlaceReferenceResolver,
  type SavedReferenceResolverDependencies,
} from './runtime-saved-reference-resolver';
import type { SavedPlaceReferenceResolver } from '../../tools/types';

export type RuntimeSavedReferenceComposition = {
  readonly resolver: SavedPlaceReferenceResolver;
  readonly handoff: SavedReferenceDetailsHandoff;
};

const isSavedReferenceNamespace = (value: unknown): value is SavedReferenceNamespace => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.getByName === 'function';
};

export const runtimeSavedReferenceNamespaceFor = (
  env: unknown,
): SavedReferenceNamespace | undefined => {
  if (typeof env !== 'object' || env === null || !('SAVED_REFERENCES' in env)) return undefined;
  const namespace = env.SAVED_REFERENCES;
  return isSavedReferenceNamespace(namespace) ? namespace : undefined;
};

export const createRuntimeSavedReferenceComposition = (input: {
  readonly namespace: SavedReferenceNamespace;
  readonly ownerScopeRef: string;
  readonly registry: SavedReferenceCandidateRegistry;
  readonly transport: GooglePlaceDetailsTransport;
  readonly clock: () => string;
  readonly sessionExpiresAt: () => string | undefined;
  readonly reserveProviderRequest: () => boolean;
  readonly requestSignal?: AbortSignal;
  readonly areaLabelFor?: (context: HarnessContext) => string | undefined;
  readonly signalFor?: (execution: ToolExecutionContext) => AbortSignal | undefined;
}): RuntimeSavedReferenceComposition => {
  const handoff = createSavedReferenceDetailsHandoff(input.clock);
  const owner = createOwnerSavedReferenceRpc(input.namespace, input.ownerScopeRef);
  const provider = createSavedReferenceGoogleProvider({
    transport: input.transport,
    handoff,
    areaLabelFor: input.areaLabelFor ?? ((context) => context.preferences.areaText ?? undefined),
    now: input.clock,
    sessionExpiresAt: input.sessionExpiresAt,
    ...(input.requestSignal === undefined ? {} : { requestSignal: input.requestSignal }),
    ...(input.signalFor === undefined ? {} : { signalFor: input.signalFor }),
  });
  const resolverDependencies: SavedReferenceResolverDependencies = {
    owner,
    provider,
    registry: createHandoffCandidateRegistry(input.registry, handoff),
    supportedProviders: ['google_places'],
    budget: { reserveProviderRequest: input.reserveProviderRequest },
    now: input.clock,
    sessionExpiresAt: input.sessionExpiresAt,
  };
  const resolver = createSavedPlaceReferenceResolver(resolverDependencies);
  return { resolver: createHandoffAwareSavedResolver(resolver, handoff), handoff };
};
