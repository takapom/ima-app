import { Linking, Share } from 'react-native';
import type { PublicCard } from '@ima/contracts';
import {
  buildAppleWalkingMapUrl,
  type JourneyMapOpenResult,
  type JourneyMapService,
  type WalkingMapDestinationResolver,
} from './journey-map';
import type { JourneyShareService, ShareSheetResult } from './journey-share';
import { prepareSourceLink, type JourneySourceLinkService } from './journey-source-link';

/**
 * Native adapters stay at the service boundary. The resolver must receive
 * coordinates from an existing public/saved-place source; this adapter never
 * geocodes a name or address on its own.
 */
export const createNativeJourneyMapService = (
  resolveDestination: WalkingMapDestinationResolver,
): JourneyMapService => ({
  openWalkingMap: async (card: PublicCard): Promise<JourneyMapOpenResult> => {
    const map = buildAppleWalkingMapUrl(resolveDestination(card));
    if (map.status !== 'ready') return map;
    try {
      if (!(await Linking.canOpenURL(map.url))) {
        return { status: 'unavailable', reason: 'link_unavailable' };
      }
      await Linking.openURL(map.url);
      return { status: 'opened' };
    } catch {
      return { status: 'failed', reason: 'native_unavailable' };
    }
  },
});

export const createNativeJourneyShareService = (): JourneyShareService => ({
  openShareSheet: async ({ message }): Promise<ShareSheetResult> => {
    try {
      const result = await Share.share({ message });
      if (result.action === Share.dismissedAction) return { status: 'cancelled' };
      if (result.action === Share.sharedAction) return { status: 'opened' };
      return { status: 'failed', reason: 'share_unavailable' };
    } catch {
      return { status: 'failed', reason: 'share_unavailable' };
    }
  },
});

export const createNativeJourneySourceLinkService = (): JourneySourceLinkService => ({
  openSourceLink: async (sourceLink) => {
    const prepared = prepareSourceLink(sourceLink);
    if (prepared.status !== 'ready') return prepared;
    try {
      if (!(await Linking.canOpenURL(prepared.url))) {
        return { status: 'unavailable', reason: 'link_unavailable' };
      }
      await Linking.openURL(prepared.url);
      return { status: 'opened' };
    } catch {
      return { status: 'failed', reason: 'native_unavailable' };
    }
  },
});
