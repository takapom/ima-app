export { createExpoLocationService } from '@mobile/platform/location/expo-location-adapter';
export {
  createLocationService,
  LOCATION_MAX_AGE_MS,
  LOCATION_PRECISE_ACCURACY_METERS,
  LOCATION_TIMEOUT_CAP_MS,
  LOCATION_TIMEOUT_MS,
} from '@mobile/platform/location/location-service';
export type {
  ExpoLocationSdk,
  LocationAcquireOptions,
  LocationAcquireResult,
  LocationCancellation,
  LocationService,
  LocationServiceOptions,
} from '@mobile/platform/location/types';
