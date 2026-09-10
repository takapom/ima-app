import {
  createJourneyApiController,
  type JourneyApiController,
  type JourneyApiControllerOptions,
  type JourneyLocalRestorePort,
} from './journey-controller';
import { createJourneyApiClient } from './client';
import type { ApiClientOptions } from './types';

/**
 * The host chooses fixture or live explicitly and supplies credentials through this port.
 * No native credential store or SQLite SDK is selected in this composition layer.
 */
export type JourneyApiCompositionOptions = ApiClientOptions & {
  readonly localRestore?: JourneyLocalRestorePort;
  readonly clock?: JourneyApiControllerOptions['clock'];
};

export const createJourneyApiComposition = (
  options: JourneyApiCompositionOptions,
): JourneyApiController =>
  createJourneyApiController({
    api: createJourneyApiClient(options),
    ...(options.localRestore === undefined ? {} : { localRestore: options.localRestore }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
