import type { PhotoReferenceRpc } from '../../src/providers/photo/rpc';
import { unavailableStationWaypoint } from '../../src/providers/routes/resolver';
import {
  photoDependenciesFor,
  runtimeProductionProviderAvailabilityFor,
  type RuntimeProductionAvailabilityConfiguration,
} from '../../src/runtime/runtime-production-provider-config';
import { describe, expect, it } from 'vitest';
import { context, makeFixture } from '../providers/places-details/adapter-fixtures';

const routeConfiguration = {
  routesEnabled: true,
  googleRoutesApiKey: 'routes-key',
  routeObservationPolicy: () => undefined,
  currentOriginRefFor: () => 'current-location',
} satisfies RuntimeProductionAvailabilityConfiguration;

const allProviderConfiguration: RuntimeProductionAvailabilityConfiguration = {
  ...routeConfiguration,
  journeyDataset: {
    read: () => Promise.reject(new Error('config test does not read the dataset')),
    readRevision: () => Promise.resolve(1),
  },
  buildServiceDateContext: () => undefined,
  lastTrainObservationPolicy: () => undefined,
  fromStationRefFor: () => 'station-from',
  resolveStationWaypoint: unavailableStationWaypoint,
  photosEnabled: true,
  photoTokenSecret: 'photo-secret',
  photoDisplayPolicyFor: () => undefined,
};

describe('production provider capability gates', () => {
  it('keeps current-location Routes available without station or photo dependencies', () => {
    const availability = runtimeProductionProviderAvailabilityFor({
      env: {},
      context,
      placesEnabled: true,
      activeJourneyRevision: null,
      configuration: routeConfiguration,
    });

    expect(availability).toMatchObject({
      routesEnabled: true,
      lastTrainEnabled: false,
      photosEnabled: false,
    });
  });

  it('requires every LastTrain and Photos gate and preserves the DO RPC receiver', async () => {
    let receiverSeen = false;
    const rpc: PhotoReferenceRpc = {
      putPhotoReference: () => Promise.resolve({ ok: true }),
      getPhotoReference: () => Promise.resolve({ ok: true, record: null }),
    };
    const namespace = {
      marker: 'threads-namespace',
      getByName(this: { marker: string }, _threadId: string): PhotoReferenceRpc {
        if (this.marker !== 'threads-namespace') throw new Error('RPC receiver was lost');
        receiverSeen = true;
        return rpc;
      },
    };
    const env = { THREADS: namespace };
    const availability = runtimeProductionProviderAvailabilityFor({
      env,
      context,
      placesEnabled: true,
      activeJourneyRevision: 1,
      configuration: allProviderConfiguration,
      deviceId: 'device-config-test',
    });

    expect(availability).toMatchObject({
      routesEnabled: true,
      lastTrainEnabled: true,
      photosEnabled: true,
    });
    const fixture = makeFixture();
    const photoDependencies = photoDependenciesFor({
      env,
      configuration: allProviderConfiguration,
      registry: fixture.registry,
      context,
      deviceId: 'device-config-test',
    });
    if (photoDependencies === undefined) throw new Error('photo dependencies were not assembled');
    await photoDependencies.codec.issue(
      {
        ownerScopeRef: context.ownerScopeRef,
        threadId: context.threadId,
        turnId: context.turnId,
        revision: context.revision,
        deviceId: 'device-config-test',
        photoRef: 'places/place-a/photos/photo-1',
      },
      context.serverNow,
    );
    expect(receiverSeen).toBe(true);
    expect(photoDependencies.sourceTurnId).toBe(context.turnId);
    expect(photoDependencies.sourceRevision).toBe(context.revision);
  });

  it('disables LastTrain when a verified station resolver is absent', () => {
    const withoutStation = { ...allProviderConfiguration };
    delete withoutStation.resolveStationWaypoint;
    const availability = runtimeProductionProviderAvailabilityFor({
      env: {},
      context,
      placesEnabled: true,
      activeJourneyRevision: 1,
      configuration: withoutStation,
    });

    expect(availability.lastTrainEnabled).toBe(false);
  });

  it('disables Photos when the configured token secret is empty', () => {
    const availability = runtimeProductionProviderAvailabilityFor({
      env: { THREADS: { getByName: () => ({}) } },
      context,
      placesEnabled: true,
      activeJourneyRevision: null,
      configuration: {
        photosEnabled: true,
        photoTokenSecret: '   ',
        photoDisplayPolicyFor: () => undefined,
      },
      deviceId: 'device-config-test',
    });

    expect(availability.photosEnabled).toBe(false);
  });
});
