import { createLiveOpenAIProvider } from '../../src/model/provider';
import { devFixtureOverridesFor } from '../../src/runtime/composition/runtime-dev-fixture';
import { resolveRuntimeOperationalGate } from '../../src/runtime/composition/runtime-operational-gate';
import { productionSecret } from '../../src/runtime/composition/runtime-production-support';
import { ThreadDO as ProductionThreadDO } from '../../src/thread-do';

export const isDevLiveModelEnvironment = (env: unknown): boolean =>
  typeof env === 'object' &&
  env !== null &&
  'IMA_ENV' in env &&
  env.IMA_ENV === 'dev' &&
  'IMA_RUNTIME_MODE' in env &&
  env.IMA_RUNTIME_MODE === 'live';

/** Only the local development entry exports this host; production keeps its own composition. */
export class ThreadDO extends ProductionThreadDO {
  protected override createRuntimeProductionOverrides() {
    const base = super.createRuntimeProductionOverrides();
    if (
      !isDevLiveModelEnvironment(this.env) ||
      !resolveRuntimeOperationalGate(this.env).enabled('openai') ||
      !productionSecret(this.env, 'OPENAI_API_KEY')
    ) {
      return base;
    }
    return devFixtureOverridesFor({
      ...base,
      modelForTurn: createLiveOpenAIProvider(this.env).model,
      routesEnabled: false,
      // A disabled route has no origin; observations must use the same context as validation.
      currentOriginRefFor: () => undefined,
      photosEnabled: false,
      lastTrainEnabled: false,
      modelContextFieldPolicy: {
        evidence: {
          identity: 'allow',
          opening_hours: 'allow',
          price: 'allow',
          photos: 'deny',
          contact: 'deny',
          facilities: 'deny',
          walking_route: 'deny',
          last_train: 'deny',
        },
        history: 'allow',
        cardSet: 'allow',
        displayName: 'allow',
      },
    });
  }
}
