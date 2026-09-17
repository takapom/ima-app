import { describe, expect, it } from 'vitest';
import { capabilitiesWithProviders } from '../../../src/runtime/composition/runtime-production-provider-config';
import { harnessContextFor } from '../../../src/runtime/composition/runtime-production-support';
import { buildRequest } from './runtime-production-factory-fixtures';

const context = harnessContextFor(buildRequest, buildRequest.runtimeInput, buildRequest.serverNow);
describe('Hot Pepper capabilities', () => {
  it.each([true, false])(
    'advertises only connected capabilities when enabled=%s',
    (placesEnabled) => {
      const availability = { placesEnabled };
      const capabilities = capabilitiesWithProviders(context.capabilities, availability);
      expect(capabilities.detailFields).toEqual(
        placesEnabled ? ['identity', 'opening_hours', 'price', 'facilities', 'photos'] : [],
      );
      expect(capabilities.walkingRoute).toBe(false);
      expect(capabilities.lastTrain).toBe(false);
    },
  );
});
