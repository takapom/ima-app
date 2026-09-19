import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import { sessionExpiryAt } from '@worker/runtime/retention/session-expiry-policy';
import {
  createRuntimeProductionContextStore,
  type RuntimeProductionContextStore,
} from '@worker/runtime/context/runtime-production-context';
import type { RuntimeProductionContextPersistence } from '@worker/runtime/context/runtime-production-context-reference';

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
