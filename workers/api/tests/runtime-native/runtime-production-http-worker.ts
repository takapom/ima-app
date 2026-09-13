import {
  createHttpRouterConfig,
  createThreadScopeAuthorizer,
  type BootstrapEnv,
} from '../../src/bootstrap';
import type { RuntimeFieldUsePolicy } from '../../src/runtime/context/runtime-field-policy';
import type { PhotoDisplayPolicySnapshot } from '../../src/providers/photo/issuance';
import type { RuntimeProductionOverrides } from '../../src/runtime/composition/runtime-production-types';
import { routeRequest } from '../../src/http/router';
import { RateLimitDO } from '../../src/thread-do';
import { TelemetryDO } from '../../src/telemetry/telemetry-do';
import { SavedReferenceDO } from '../../src/saved-references/saved-reference-do';
import { ProductionThreadDO, RUNTIME_PRODUCTION_NOW } from './runtime-production-worker';

const FIXTURE_PHOTO_POLICY_RECORD: RuntimeFieldUsePolicy['display'] = {
  decision: 'allow',
  activation: 'fixture_only',
  fieldStatus: 'known',
  policyStatus: 'available',
};

const FIXTURE_PHOTO_DISPLAY_POLICY = {
  policy: {
    llm_input: FIXTURE_PHOTO_POLICY_RECORD,
    display: FIXTURE_PHOTO_POLICY_RECORD,
    persistence: FIXTURE_PHOTO_POLICY_RECORD,
  },
  mode: 'fixture',
} satisfies PhotoDisplayPolicySnapshot;

export const PRODUCTION_PHOTO_FIXTURE_URI =
  'https://lh3.googleusercontent.com/m16-production-photo=w800-h600';
export const PRODUCTION_PHOTO_FIXTURE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

export class ProductionHttpThreadDO extends ProductionThreadDO {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.configureRuntimeScenario('multi-turn');
  }

  protected override photoReferenceNow(): string {
    return RUNTIME_PRODUCTION_NOW;
  }

  protected override runtimeProductionPhotoDisplayPolicyFor(): RuntimeProductionOverrides['photoDisplayPolicyFor'] {
    return () => FIXTURE_PHOTO_DISPLAY_POLICY;
  }
}

const productionPhotoFetcher: typeof fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === 'https://places.googleapis.com') {
    return Promise.resolve(
      new Response(JSON.stringify({ photoUri: PRODUCTION_PHOTO_FIXTURE_URI }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  if (url.origin === 'https://lh3.googleusercontent.com') {
    return Promise.resolve(
      new Response(PRODUCTION_PHOTO_FIXTURE_BYTES, {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(PRODUCTION_PHOTO_FIXTURE_BYTES.byteLength),
        },
      }),
    );
  }
  return Promise.resolve(new Response(null, { status: 404 }));
};

const handler = {
  async fetch(
    request: Request,
    env: BootstrapEnv,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    const photoClock = request.url.includes('/v1/photos/')
      ? () => RUNTIME_PRODUCTION_NOW
      : undefined;
    return routeRequest(
      request,
      createHttpRouterConfig(env, {
        ownership: createThreadScopeAuthorizer(env.THREADS),
        photoFetcher: productionPhotoFetcher,
        ...(photoClock === undefined ? {} : { clock: photoClock }),
        waitUntil: (promise) => executionContext.waitUntil(promise),
      }),
    );
  },
} satisfies ExportedHandler<BootstrapEnv>;

export { ProductionHttpThreadDO as ThreadDO, RateLimitDO, SavedReferenceDO, TelemetryDO };
export default handler;
