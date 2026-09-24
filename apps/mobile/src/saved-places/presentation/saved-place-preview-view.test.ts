import { describe, expect, it } from 'vitest';
import type { PublicPlaceDetailsData, RetentionMetadata } from '@ima/contracts';
import {
  savedPlaceItemsFor,
  savedPlacePreviewDisplayFor,
  savedPlacePreviewFailureTextFor,
} from '@mobile/saved-places/presentation/saved-place-preview-view';
import type {
  SavedPlaceListItem,
  SavedPlaceListResult,
} from '@mobile/saved-places/services/saved-place-list';
import {
  createSavedPlacePreviewState,
  type SavedPlacePreviewState,
} from '@mobile/saved-places/state/saved-place-preview';
import type {
  LocalSavedEntryId,
  ServerSavedPlaceRef,
} from '@mobile/saved-places/services/saved-place-types';

const retention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-11T05:00:00.000Z',
  freshUntil: '2026-09-11T04:00:00.000Z',
  displayUntil: '2026-09-11T04:30:00.000Z',
  retentionUntil: '2026-09-11T05:00:00.000Z',
  deletionScheduledAt: '2026-09-11T05:00:00.000Z',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const details: PublicPlaceDetailsData = {
  items: [
    {
      candidateId: 'candidate-1',
      fields: {
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
              evidenceId: 'evidence-1',
              attribution: {
                label: 'Google Maps',
                sourceLink: 'https://maps.google.com/?cid=1',
              },
              retention,
            },
          ],
        },
      },
    },
  ],
};

const asLocal = (value: string): LocalSavedEntryId => value as LocalSavedEntryId;
const asServer = (value: string): ServerSavedPlaceRef => value as ServerSavedPlaceRef;

const listItem = (overrides: Partial<SavedPlaceListItem> = {}): SavedPlaceListItem => ({
  localSavedEntryId: asLocal('local-1'),
  serverSavedPlaceRef: asServer('saved-ref-1'),
  name: '夜カフェ',
  area: '恵比寿',
  savedAt: '2026-09-10T12:00:00.000Z',
  sessionExpiresAt: '2026-09-11T05:00:00.000Z',
  displayUntil: '2026-09-11T04:30:00.000Z',
  retentionUntil: '2026-09-11T05:00:00.000Z',
  deletionScheduledAt: '2026-09-11T05:00:00.000Z',
  restoreMode: 'full',
  needsRefetch: false,
  ...overrides,
});

const previewState = (overrides: Partial<SavedPlacePreviewState>): SavedPlacePreviewState => ({
  ...createSavedPlacePreviewState(),
  ...overrides,
});

describe('saved place preview view projection', () => {
  it('maps full and reference-only rows to opaque drawer items', () => {
    const result: SavedPlaceListResult = {
      status: 'available',
      items: [
        listItem(),
        listItem({
          localSavedEntryId: asLocal('local-2'),
          serverSavedPlaceRef: asServer('saved-ref-2'),
          name: null,
          area: null,
          restoreMode: 'reference_only',
          needsRefetch: true,
        }),
      ],
    };

    expect(savedPlaceItemsFor(result)).toEqual([
      { id: 'saved-ref-1', name: '夜カフェ', area: '恵比寿' },
      { id: 'saved-ref-2', name: '店の情報を確認', area: '保存: 9/10 21:00' },
    ]);
    expect(savedPlaceItemsFor({ status: 'unavailable', reason: 'storage_unavailable' })).toEqual(
      [],
    );
  });

  it('projects only the validated identity payload into preview text', () => {
    const state = previewState({
      status: 'ready',
      selected: {
        localSavedEntryId: asLocal('local-1'),
        serverSavedPlaceRef: asServer('saved-ref-1'),
        name: null,
        area: null,
        savedAt: '2026-09-10T12:00:00.000Z',
        sessionExpiresAt: '2026-09-11T05:00:00.000Z',
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
        restoreMode: 'reference_only',
        needsRefetch: true,
      },
      payload: {
        savedPlaceRef: asServer('saved-ref-1'),
        candidateId: 'candidate-1',
        evidenceIds: ['evidence-1'],
        data: details,
      },
    });
    expect(savedPlacePreviewDisplayFor(state)).toEqual({
      name: '夜カフェ',
      area: '恵比寿',
      attributions: [{ label: 'Google Maps', sourceLink: 'https://maps.google.com/?cid=1' }],
    });
  });

  it('preserves the identity projection when nullable attribution is absent', () => {
    const sourceIdentity = details.items[0]?.fields.identity;
    if (sourceIdentity?.status !== 'known') throw new Error('expected known identity fixture');
    const withoutAttribution: PublicPlaceDetailsData = {
      items: [
        {
          candidateId: 'candidate-1',
          fields: {
            identity: {
              status: 'known',
              value: sourceIdentity.value,
              evidence: [{ evidenceId: 'evidence-no-attribution', attribution: null, retention }],
            },
          },
        },
      ],
    };
    const state = previewState({
      status: 'ready',
      selected: { ...listItem(), name: null, area: null, restoreMode: 'reference_only' },
      payload: {
        savedPlaceRef: asServer('saved-ref-1'),
        candidateId: 'candidate-1',
        evidenceIds: ['evidence-no-attribution'],
        data: withoutAttribution,
      },
    });
    expect(savedPlacePreviewDisplayFor(state)).toEqual({
      name: '夜カフェ',
      area: '恵比寿',
      attributions: [],
    });
  });

  it('keeps all source credits in the saved-place presentation', () => {
    const sourceIdentity = details.items[0]?.fields.identity;
    if (sourceIdentity?.status !== 'known') throw new Error('expected known identity fixture');
    const sourceEvidence = sourceIdentity.evidence[0];
    if (sourceEvidence === undefined) throw new Error('expected identity evidence fixture');
    const multiSourceDetails: PublicPlaceDetailsData = {
      items: [
        {
          candidateId: 'candidate-1',
          fields: {
            identity: {
              status: 'known',
              value: sourceIdentity.value,
              evidence: [
                {
                  ...sourceEvidence,
                  attributions: [
                    { label: 'Google Maps', sourceLink: 'https://maps.google.com/?cid=1' },
                    { label: 'ホットペッパー', sourceLink: 'https://www.hotpepper.jp' },
                  ],
                },
              ],
            },
          },
        },
      ],
    };
    const state = previewState({
      status: 'ready',
      selected: { ...listItem(), name: null, area: null, restoreMode: 'reference_only' },
      payload: {
        savedPlaceRef: asServer('saved-ref-1'),
        candidateId: 'candidate-1',
        evidenceIds: [sourceEvidence.evidenceId],
        data: multiSourceDetails,
      },
    });

    expect(savedPlacePreviewDisplayFor(state)?.attributions).toEqual([
      { label: 'Google Maps', sourceLink: 'https://maps.google.com/?cid=1' },
      { label: 'ホットペッパー', sourceLink: 'https://www.hotpepper.jp' },
    ]);
  });

  it('maps failure reasons without exposing raw API errors', () => {
    const state = previewState({
      status: 'failed',
      failure: { reason: 'api', error: { kind: 'offline' } },
    });
    expect(savedPlacePreviewDisplayFor(state)).toBeNull();
    expect(savedPlacePreviewFailureTextFor(state.failure)).toBe(
      '保存店の詳細を取得できませんでした。',
    );
    expect(savedPlacePreviewFailureTextFor({ reason: 'clock_unavailable' })).toContain('時刻');
  });
});
