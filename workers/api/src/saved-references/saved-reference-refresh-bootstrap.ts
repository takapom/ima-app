import {
  createConfiguredSavedReferenceRefresh,
  type SavedReferenceRefreshEnvironment,
  type SavedReferenceRefreshRetentionPolicy,
} from './saved-reference-refresh';
import type { GooglePlaceDetailsTransport } from '../providers/places-details/types';

export type SavedReferenceRefreshBootstrapOptions = {
  readonly savedReferenceRefreshTransport?: GooglePlaceDetailsTransport;
  readonly savedReferenceRefreshFetcher?: typeof fetch;
  readonly savedReferenceRefreshPolicy?: SavedReferenceRefreshRetentionPolicy;
  readonly savedReferenceRefreshTimeoutMs?: number;
  readonly clock?: () => string;
};

export const createSavedReferenceRefreshForBootstrap = (
  environment: SavedReferenceRefreshEnvironment,
  options: SavedReferenceRefreshBootstrapOptions,
): ReturnType<typeof createConfiguredSavedReferenceRefresh> =>
  createConfiguredSavedReferenceRefresh(environment, {
    ...(options.savedReferenceRefreshTransport === undefined
      ? {}
      : { transport: options.savedReferenceRefreshTransport }),
    ...(options.savedReferenceRefreshFetcher === undefined
      ? {}
      : { fetcher: options.savedReferenceRefreshFetcher }),
    ...(options.savedReferenceRefreshPolicy === undefined
      ? {}
      : { retentionFor: options.savedReferenceRefreshPolicy }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.savedReferenceRefreshTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.savedReferenceRefreshTimeoutMs }),
  });
