import {
  createPlacesSearchContinuation,
  type PlacesSearchContinuation,
} from '@worker/adapters/out/providers/places-search/continuation';
import { createPlacesSearchCursorStore } from '@worker/adapters/out/providers/places-search/cursor';

export const createFactoryContinuation = (input: {
  readonly secret: string | undefined;
  readonly now: () => number;
}): PlacesSearchContinuation | undefined => {
  if (input.secret === undefined) return undefined;
  return createPlacesSearchContinuation({
    store: createPlacesSearchCursorStore({ secret: input.secret, now: input.now }),
    now: input.now,
  });
};
