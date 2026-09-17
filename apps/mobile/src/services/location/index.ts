export { createExpoLocationService } from '@mobile/services/location/expo-location-adapter';
export {
  createLocationService,
  LOCATION_MAX_AGE_MS,
  LOCATION_PRECISE_ACCURACY_METERS,
  LOCATION_TIMEOUT_CAP_MS,
  LOCATION_TIMEOUT_MS,
} from '@mobile/services/location/location-service';
export type {
  ExpoLocationSdk,
  LocationAcquireOptions,
  LocationAcquireResult,
  LocationCancellation,
  LocationService,
  LocationServiceOptions,
} from '@mobile/services/location/types';
