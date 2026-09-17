import {
  createHttpRouterConfig,
  createThreadScopeAuthorizer,
  type BootstrapEnv,
} from '@worker/composition/bootstrap';
import { routeRequest } from '@worker/adapters/inbound/http/router';
import {
  AppIntegrityDO,
  type AppIntegrityNamespace,
} from '@worker/adapters/outbound/persistence/security/app-integrity-do';
import type { AppIntegrityVerifier } from '@worker/security/app-integrity';
import { RateLimitDO, ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';

export { AppIntegrityDO, RateLimitDO, ThreadDO };

type AppIntegrityTestEnv = BootstrapEnv & {
  readonly APP_INTEGRITY: AppIntegrityNamespace;
};

const verifier: AppIntegrityVerifier = {
  verifyAttestation: async () => {
    await Promise.resolve();
    return { verified: true, keyRef: 'fixture-verifier-key' };
  },
  verifyAssertion: async () => {
    await Promise.resolve();
    return { verified: true, counter: 1 };
  },
};

export default {
  async fetch(
    request: Request,
    env: AppIntegrityTestEnv,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    const ownership = createThreadScopeAuthorizer(env.THREADS);
    return routeRequest(
      request,
      createHttpRouterConfig(env, {
        ownership,
        appIntegrityVerifier: verifier,
        waitUntil: (promise) => executionContext.waitUntil(promise),
      }),
    );
  },
} satisfies ExportedHandler<AppIntegrityTestEnv>;
