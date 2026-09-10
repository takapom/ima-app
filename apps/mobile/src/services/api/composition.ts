import {
  createJourneyApiController,
  type JourneyApiController,
  type JourneyApiControllerOptions,
  type JourneyLocalRestorePort,
} from './journey-controller';
import { createJourneyApiClient } from './client';
import type { ApiClientOptions, JourneyApiClient } from './types';

/**
 * The host chooses fixture or live explicitly and supplies credentials through this port.
 * No native credential store or SQLite SDK is selected in this composition layer.
 */
export type JourneyApiCompositionOptions = ApiClientOptions & {
  /** Reuse one client when another host service needs the same authenticated API. */
  readonly api?: JourneyApiClient;
  readonly localRestore?: JourneyLocalRestorePort;
  readonly clock?: JourneyApiControllerOptions['clock'];
};

export const createJourneyApiComposition = (
  options: JourneyApiCompositionOptions,
): JourneyApiController => {
  const api = options.api ?? createJourneyApiClient(options);
  return createJourneyApiController({
    api,
    ...(options.localRestore === undefined ? {} : { localRestore: options.localRestore }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
};
