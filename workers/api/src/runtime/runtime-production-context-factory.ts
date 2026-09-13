import type { CandidateObservationRegistryPort } from '@ima/core';
import { sessionExpiryAt } from './composition/runtime-production-support';
import {
  createRuntimeProductionContextStore,
  type RuntimeProductionContextStore,
} from './runtime-production-context';
import type { RuntimeProductionContextPersistence } from './runtime-production-context-reference';

export const createFactoryRuntimeContext = (input: {
  readonly registry: CandidateObservationRegistryPort;
  readonly threadCreatedAt?: string;
  readonly persistence?: RuntimeProductionContextPersistence;
  readonly clock: () => string;
}): {
  fixedSessionExpiresAt: string | undefined;
  ensureSessionExpiry: (serverNow: string) => string;
  contextStore: RuntimeProductionContextStore;
} => {
  let fixedSessionExpiresAt =
    input.threadCreatedAt === undefined ? undefined : sessionExpiryAt(input.threadCreatedAt);
  const contextStore = createRuntimeProductionContextStore({
    registry: input.registry,
    ...(input.persistence === undefined ? {} : { persistence: input.persistence }),
    sessionExpiresAt: () => fixedSessionExpiresAt,
    now: input.clock,
  });
  return {
    get fixedSessionExpiresAt(): string | undefined {
      return fixedSessionExpiresAt;
    },
    ensureSessionExpiry(serverNow: string): string {
      fixedSessionExpiresAt ??= sessionExpiryAt(serverNow);
      return fixedSessionExpiresAt;
    },
    contextStore,
  };
};
