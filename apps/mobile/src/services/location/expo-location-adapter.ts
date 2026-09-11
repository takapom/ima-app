import * as Location from 'expo-location';
import { createLocationService } from './location-service';
import type { LocationService, LocationServiceOptions } from './types';

/**
 * Builds the one-shot foreground adapter. This factory does not request
 * permission; `acquire` is the explicit send-time boundary that does so.
 * Background permission and watch APIs are intentionally not exposed.
 */
export const createExpoLocationService = (options: LocationServiceOptions = {}): LocationService =>
  createLocationService(
    {
      getForegroundPermissionsAsync: () => Location.getForegroundPermissionsAsync(),
      requestForegroundPermissionsAsync: () => Location.requestForegroundPermissionsAsync(),
      hasServicesEnabledAsync: () => Location.hasServicesEnabledAsync(),
      getLastKnownPositionAsync: (maxAgeMs) =>
        Location.getLastKnownPositionAsync({ maxAge: maxAgeMs }),
      getCurrentPositionAsync: () =>
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
    },
    options,
  );
