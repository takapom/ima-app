import { ThreadDO as ProductionThreadDO } from '@api/thread-do';

export const isDevLiveModelEnvironment = (env: unknown): boolean =>
  typeof env === 'object' &&
  env !== null &&
  'IMA_ENV' in env &&
  env.IMA_ENV === 'dev' &&
  'IMA_RUNTIME_MODE' in env &&
  env.IMA_RUNTIME_MODE === 'live';

export { ProductionThreadDO as ThreadDO };
