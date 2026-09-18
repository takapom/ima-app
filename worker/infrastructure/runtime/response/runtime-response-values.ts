import type { PhotoInfo } from '@ima/contracts';
import type { ValidatedCard } from '@ima/core';
import type {
  LastTrainInfo,
  OpeningHours,
  PlaceIdentity,
  PriceInfo,
  WalkingRoute,
} from '@ima/core';

type CorePhotoInfo = NonNullable<ValidatedCard['photos']>;
type CoreFacilitiesInfo = NonNullable<ValidatedCard['facilities']>;

/** Server-issued photo handle lookup; Core photo references never cross this boundary. */
export type PhotoTokenLookup = (candidateId: string, photoRef: string) => string | undefined;

export const publicIdentity = (value: PlaceIdentity) => ({
  name: value.name,
  area: value.area,
  address: value.address,
  category: value.category,
  stationName: value.stationName,
  accessText: value.accessText,
  businessStatus: value.businessStatus,
  sourceUrl: value.sourceUrl,
});

export const publicOpeningHours = (value: OpeningHours) => ({
  timeZone: value.timeZone,
  intervals: value.intervals.map((interval) => ({
    startAt: interval.startAt,
    endAt: interval.endAt,
  })),
  weeklyText: [...value.weeklyText],
  evaluatedAt: value.evaluatedAt,
  listedOpenAtEvaluation: value.listedOpenAtEvaluation,
  nextBoundaryAt: value.nextBoundaryAt,
  lastOrderAt: value.lastOrderAt,
  lastOrderRaw: value.lastOrderRaw,
});

export const publicPrice = (value: PriceInfo) => ({
  level: value.level,
  range:
    value.range === null
      ? null
      : {
          currency: value.range.currency,
          min: value.range.min,
          max: value.range.max,
          unit: value.range.unit,
        },
  rawLabel: value.rawLabel,
});

export const publicPhotos = (
  value: CorePhotoInfo,
  candidateId: string,
  resolvePhotoToken: PhotoTokenLookup | undefined,
):
  | {
      readonly status: 'known';
      readonly value: PhotoInfo;
    }
  | { readonly status: 'unknown'; readonly reason: string } => {
  if (value.photos.length === 0) {
    return { status: 'known', value: { photos: [] } };
  }
  if (resolvePhotoToken === undefined) {
    return { status: 'unknown', reason: '写真を表示できません' };
  }
  const photos = [];
  for (const photo of value.photos) {
    const photoToken = resolvePhotoToken(candidateId, photo.photoRef);
    if (photoToken === undefined) continue;
    photos.push({
      photoToken,
      attributions: photo.attributions.map((attribution) => ({
        displayName: attribution.displayName,
        uri: attribution.uri,
      })),
      sourceUrl: photo.sourceUrl,
    });
  }
  if (value.photos.length > 0 && photos.length === 0) {
    return { status: 'unknown', reason: '写真を表示できません' };
  }
  return {
    status: 'known',
    value: {
      photos,
      ...(photos.length < value.photos.length
        ? { partialReason: '一部の写真は表示できません' }
        : {}),
    },
  };
};

export const publicFacilities = (value: CoreFacilitiesInfo) => ({
  wifi: value.wifi,
  nonSmoking: value.nonSmoking,
  privateRoom: value.privateRoom,
  parking: value.parking,
  sourceText: value.sourceText,
});

export const publicWalkingRoute = (value: WalkingRoute) => ({
  originRef: value.originRef,
  destinationCandidateId: value.destinationCandidateId,
  originRevision: value.originRevision,
  evaluatedAt: value.evaluatedAt,
  durationSeconds: value.durationSeconds,
  distanceMeters: value.distanceMeters,
  warnings: value.warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
  })),
});

export const publicLastTrain = (value: LastTrainInfo) => ({
  serviceDate: value.serviceDate,
  fromStationRef: value.fromStationRef,
  homeStationRef: value.homeStationRef,
  journeyRef: value.journeyRef,
  lastDepartureAt: value.lastDepartureAt,
  arrivesHomeAt: value.arrivesHomeAt,
  transfers: value.transfers.map((transfer) => ({
    fromStationRef: transfer.fromStationRef,
    toStationRef: transfer.toStationRef,
    departureAt: transfer.departureAt,
    arrivalAt: transfer.arrivalAt,
  })),
  placeToStationSeconds: value.placeToStationSeconds,
  arrivePlaceAt: value.arrivePlaceAt,
  leaveBy: value.leaveBy,
  availableStaySeconds: value.availableStaySeconds,
  minimumStayMinutes: value.minimumStayMinutes,
  usable: value.usable,
});
