import { describe, expect, it } from 'vitest';
import type { PublicCard } from '@ima/contracts';
import {
  triggerDecisionHaptics,
  type DecisionHapticsService,
} from '@mobile/journey/services/journey-haptics';
import { buildAppleWalkingMapUrl } from '@mobile/journey/services/journey-map';
import {
  prepareJourneyShare,
  shareJourneyCandidate,
  type JourneyShareService,
} from '@mobile/journey/services/journey-share';
import {
  saveJourneyCandidate,
  type JourneyStorageService,
} from '@mobile/saved-places/services/journey-storage';
import { journeyShareInputFor } from '@mobile/journey/services/journey-share-input';
import type { LocalSavedEntryId } from '@mobile/saved-places/services/saved-place-types';

const retention = {
  retentionDecision: 'deny' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: '2026-09-10T00:00:00Z',
  freshUntil: '2026-09-10T00:00:00Z',
  displayUntil: '2026-09-10T00:00:00Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only' as const,
  policyStatus: 'policy_withheld' as const,
  displayPolicyStatus: 'available' as const,
};

const saveCard: PublicCard = {
  candidateId: 'candidate-1',
  facts: {
    identity: {
      status: 'known',
      value: {
        name: '夜カフェ',
        area: '恵比寿',
        address: null,
        category: 'cafe',
        stationName: null,
        accessText: null,
        businessStatus: 'operational',
        sourceUrl: null,
      },
      evidence: [
        {
          evidenceId: 'identity-1',
          attribution: null,
          retention,
        },
      ],
    },
  },
  why: {
    text: '静かに話せる',
    evidenceIds: [],
    evidence: [],
    basis: 'conversational',
    retention,
  },
};

describe('journey action services', () => {
  it('keeps map destination construction separate from sharing', () => {
    const map = buildAppleWalkingMapUrl({
      latitude: 35.6467,
      longitude: 139.71,
      mapsPolicy: 'allow',
      provenance: 'user_provided',
    });
    expect(map.status).toBe('ready');
    if (map.status !== 'ready') return;
    const prepared = prepareJourneyShare({
      name: '夜カフェ',
      walkingDurationSeconds: 12 * 60,
      mapUrl: map.url,
      attributions: [],
    });

    expect(prepared).toEqual({
      status: 'ready',
      message: '夜カフェ\n徒歩12分\nhttps://maps.apple.com/?daddr=35.6467%2C139.71&dirflg=w',
    });
  });

  it('does not share when a trusted HTTPS map link is unavailable', async () => {
    const service: JourneyShareService = {
      openShareSheet: () => Promise.resolve({ status: 'opened' }),
    };
    const result = await shareJourneyCandidate(service, {
      name: '夜カフェ',
      walkingDurationSeconds: null,
      mapUrl: null,
      attributions: [],
    });

    expect(result).toEqual({ status: 'unavailable', reason: 'map_link_missing' });
  });

  it('requires an HTTPS URL with a host before opening the share sheet', () => {
    expect(
      prepareJourneyShare({
        name: '夜カフェ',
        walkingDurationSeconds: 0,
        mapUrl: 'http://example.com/map',
        attributions: [],
      }),
    ).toEqual({ status: 'unavailable', reason: 'map_link_missing' });
    expect(
      prepareJourneyShare({
        name: '夜カフェ',
        walkingDurationSeconds: 0,
        mapUrl: 'https://',
        attributions: [],
      }),
    ).toEqual({ status: 'unavailable', reason: 'map_link_missing' });
    expect(
      prepareJourneyShare({
        name: '夜カフェ',
        walkingDurationSeconds: 0,
        mapUrl: 'https://example.com/map',
        attributions: [],
      }),
    ).toEqual({
      status: 'ready',
      message: '夜カフェ\n徒歩1分\nhttps://example.com/map',
    });
  });

  it('exposes native share opened and cancellation without claiming delivery', async () => {
    const messages: string[] = [];
    const opened: JourneyShareService = {
      openShareSheet: ({ message }) => {
        messages.push(message);
        return Promise.resolve({ status: 'opened' });
      },
    };
    const cancelled: JourneyShareService = {
      openShareSheet: () => Promise.resolve({ status: 'cancelled' }),
    };
    const candidate = {
      name: '夜カフェ',
      walkingDurationSeconds: null,
      mapUrl: 'https://example.com/map',
      attributions: [],
    };

    await expect(shareJourneyCandidate(opened, candidate)).resolves.toEqual({ status: 'opened' });
    await expect(shareJourneyCandidate(cancelled, candidate)).resolves.toEqual({
      status: 'cancelled',
    });
    expect(messages).toEqual(['夜カフェ\nhttps://example.com/map']);
  });

  it('maps a native share exception to a failure result', async () => {
    const service: JourneyShareService = {
      openShareSheet: () => Promise.reject(new Error('native unavailable')),
    };
    await expect(
      shareJourneyCandidate(service, {
        name: '夜カフェ',
        walkingDurationSeconds: 60,
        mapUrl: 'https://example.com/map',
        attributions: [],
      }),
    ).resolves.toEqual({ status: 'failed', reason: 'share_unavailable' });
  });

  it('keeps public attribution metadata in the share body', () => {
    expect(
      prepareJourneyShare({
        name: '夜カフェ',
        walkingDurationSeconds: null,
        mapUrl: 'https://example.com/map',
        attributions: [
          { label: 'Maps', sourceLink: 'https://example.com/source' },
          { label: 'Maps', sourceLink: 'https://example.com/source' },
        ],
      }),
    ).toEqual({
      status: 'ready',
      message: '夜カフェ\nhttps://example.com/map\n出典: Maps https://example.com/source',
    });
  });

  it('shares the identity place page when the provider withholds contact', () => {
    const identity = saveCard.facts.identity;
    if (identity.status !== 'known') throw new Error('identity fact is required');
    const input = journeyShareInputFor({
      ...saveCard,
      facts: {
        ...saveCard.facts,
        identity: {
          ...identity,
          value: { ...identity.value, sourceUrl: 'https://example.com/shop/1' },
        },
      },
    });

    expect(input.mapUrl).toBe('https://example.com/shop/1');
    expect(prepareJourneyShare(input)).toEqual({
      status: 'ready',
      message: '夜カフェ\nhttps://example.com/shop/1',
    });
  });

  it('keeps every SourceRef credit in the shared text, not just the retention one', () => {
    const identity = saveCard.facts.identity;
    if (identity.status !== 'known') throw new Error('identity fact is required');
    const evidence = identity.evidence[0];
    if (evidence === undefined) throw new Error('identity evidence is required');
    const input = journeyShareInputFor({
      ...saveCard,
      facts: {
        ...saveCard.facts,
        identity: {
          ...identity,
          value: { ...identity.value, sourceUrl: 'https://example.com/shop/1' },
          evidence: [
            {
              ...evidence,
              attribution: {
                label: 'Powered by 出典元',
                sourceLink: 'https://example.com/service',
              },
              attributions: [
                { label: '店舗ページ', sourceLink: 'https://example.com/shop/1' },
                { label: 'Powered by 出典元', sourceLink: 'https://example.com/service' },
              ],
            },
          ],
        },
      },
    });

    expect(input.attributions).toEqual([
      { label: '店舗ページ', sourceLink: 'https://example.com/shop/1' },
      { label: 'Powered by 出典元', sourceLink: 'https://example.com/service' },
    ]);
  });

  it('still refuses to share when neither contact nor place page is available', () => {
    expect(journeyShareInputFor(saveCard).mapUrl).toBeNull();
    expect(prepareJourneyShare(journeyShareInputFor(saveCard))).toEqual({
      status: 'unavailable',
      reason: 'map_link_missing',
    });
  });

  it('projects only currently displayable attribution into the share boundary', () => {
    const identity = saveCard.facts.identity;
    if (identity.status !== 'known') throw new Error('identity fact is required');
    const evidence = identity.evidence[0];
    if (evidence === undefined) throw new Error('identity evidence is required');
    const availableAttribution = {
      ...identity,
      evidence: [
        {
          ...evidence,
          attribution: { label: '公式サイト', sourceLink: 'https://example.com/source' },
        },
      ],
    };
    const input = journeyShareInputFor({
      ...saveCard,
      facts: { ...saveCard.facts, identity: availableAttribution },
    });

    expect(input.name).toBe('夜カフェ');
    expect(input.attributions).toEqual([
      { label: '公式サイト', sourceLink: 'https://example.com/source' },
    ]);
  });

  it('keeps save and haptics behind injectable services', async () => {
    const saved: string[] = [];
    const received: PublicCard[] = [];
    const storage: JourneyStorageService = {
      saveCandidate: (card) => {
        received.push(card);
        saved.push(card.candidateId);
        return Promise.resolve({
          status: 'saved',
          localSavedEntryId: 'local-1' as LocalSavedEntryId,
          serverSavedPlaceRef: null,
        });
      },
      decideCandidate: () => Promise.resolve({ status: 'failed', reason: 'storage_unavailable' }),
    };
    const hapticCalls: string[] = [];
    const haptics: DecisionHapticsService = {
      decision: () => {
        hapticCalls.push('decision');
      },
    };

    await expect(saveJourneyCandidate(storage, saveCard)).resolves.toEqual({
      status: 'saved',
      localSavedEntryId: 'local-1',
      serverSavedPlaceRef: null,
    });
    await expect(triggerDecisionHaptics(haptics)).resolves.toEqual({ status: 'performed' });
    expect(saved).toEqual(['candidate-1']);
    const receivedCard = received[0];
    if (receivedCard === undefined) throw new Error('save boundary did not receive the card');
    expect(receivedCard.facts.identity.status).toBe('known');
    if (receivedCard.facts.identity.status === 'known') {
      expect(receivedCard.facts.identity.evidence[0]?.retention.retentionDecision).toBe('deny');
    }
    expect(hapticCalls).toEqual(['decision']);
  });

  it('reports unavailable storage and haptics without hiding the action result', async () => {
    const storage: JourneyStorageService = {
      saveCandidate: () => Promise.reject(new Error('sqlite not connected')),
      decideCandidate: () => Promise.reject(new Error('sqlite not connected')),
    };
    const haptics: DecisionHapticsService = {
      decision: () => {
        throw new Error('native haptics not connected');
      },
    };

    await expect(saveJourneyCandidate(storage, saveCard)).resolves.toEqual({
      status: 'failed',
      reason: 'storage_unavailable',
    });
    await expect(triggerDecisionHaptics(haptics)).resolves.toEqual({
      status: 'failed',
      reason: 'haptics_unavailable',
    });
  });
});
