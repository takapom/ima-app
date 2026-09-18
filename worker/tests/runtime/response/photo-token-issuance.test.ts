import { describe, expect, it, vi } from 'vitest';
import type { CommittedResponse, ReadonlyStoredObservation } from '@ima/core';
import {
  collectPhotoTokenObservations,
  createPhotoTokenPreparer,
  preparePhotoTokens,
  type PhotoDisplayPolicySnapshot,
} from '@worker/infrastructure/runtime/response/photo-token-issuance';
import { PhotoTokenError, type PhotoTokenCodec } from '@worker/infrastructure/runtime/ports/photo';
import type { RuntimePolicyRecord } from '@worker/infrastructure/runtime/context/runtime-field-policy';

const CONTEXT = {
  ownerScopeRef: 'owner-photo',
  threadId: 'thread-photo',
  sourceTurnId: 'turn-photo',
  sourceRevision: 1,
  deviceId: 'device-photo',
  now: '2026-09-10T12:00:00.000Z',
};

const observation = (overrides: Record<string, unknown> = {}) => ({
  candidateId: 'candidate-a',
  photoRef: 'places/A/photos/one',
  displayAllowed: true,
  sessionExpiresAt: '2026-09-10T12:30:00.000Z',
  displayUntil: '2026-09-10T12:20:00.000Z',
  providerExpiresAt: null,
  ...overrides,
});

const makeCodec = (issue: PhotoTokenCodec['issue']): PhotoTokenCodec => ({
  issue,
  verify: () => Promise.reject(new Error('verify is not used by preissue tests')),
});

const policyRecord = (overrides: Partial<RuntimePolicyRecord> = {}): RuntimePolicyRecord => ({
  decision: 'allow',
  activation: 'fixture_only',
  fieldStatus: 'known',
  policyStatus: 'available',
  ...overrides,
});

const photoDisplayPolicy = (
  displayOverrides: Partial<RuntimePolicyRecord> = {},
  otherPolicy: RuntimePolicyRecord = policyRecord(),
): PhotoDisplayPolicySnapshot => ({
  policy: {
    llm_input: otherPolicy,
    display: policyRecord(displayOverrides),
    persistence: otherPolicy,
  },
  mode: 'fixture',
});

const photoRetention = {
  retentionDecision: 'allow' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: '2026-09-10T13:00:00Z',
  freshUntil: '2026-09-10T12:20:00Z',
  displayUntil: '2026-09-10T12:30:00Z',
  retentionUntil: '2026-09-10T12:45:00Z',
  deletionScheduledAt: '2026-09-10T12:45:00Z',
  attribution: null,
  restoreMode: 'full' as const,
  policyStatus: 'available' as const,
  displayPolicyStatus: 'available' as const,
};

const photoObservation: ReadonlyStoredObservation = {
  observationId: 'observation-photo',
  candidateId: 'candidate-a',
  field: 'photos',
  value: {
    photos: [{ photoRef: 'places/A/photos/one', attributions: [], sourceUrl: null }],
  },
  basis: 'provider_reported',
  fetchedAt: '2026-09-10T12:00:00Z',
  sourceUpdatedAt: null,
  expiresAt: '2026-09-10T12:25:00Z',
  freshUntil: '2026-09-10T12:20:00Z',
  contextKey: 'photo-context',
  context: {
    ownerScopeRef: CONTEXT.ownerScopeRef,
    threadId: CONTEXT.threadId,
    capabilityVersion: 'photo-v1',
    locationRevision: 0,
    originRef: null,
    homeStationRef: null,
    minimumStayMinutes: null,
    timeContext: 'now',
  },
  sources: [{ provider: 'google', recordRef: 'places/A', attribution: null, publicUrl: null }],
  retention: photoRetention,
};

const photoEvidence = {
  observationId: photoObservation.observationId,
  candidateId: photoObservation.candidateId,
  field: 'photos' as const,
  sources: photoObservation.sources,
  retention: photoRetention,
};

const photoWhy = {
  text: '写真付き候補',
  evidenceIds: [photoObservation.observationId],
  basis: 'grounded' as const,
  evidence: [photoEvidence],
};

const photoResponse: CommittedResponse = {
  presentation: 'replace',
  message: [photoWhy],
  hero: {
    candidateId: photoObservation.candidateId,
    identity: {
      name: '店A',
      area: '渋谷',
      address: null,
      category: 'cafe',
      businessStatus: 'operational',
      sourceUrl: null,
    },
    openingHours: {
      timeZone: 'UTC',
      intervals: [{ startAt: '2026-09-10T11:00:00Z', endAt: '2026-09-10T15:00:00Z' }],
      weeklyText: ['11:00-15:00'],
      evaluatedAt: CONTEXT.now,
      listedOpenAtEvaluation: true,
      nextBoundaryAt: '2026-09-10T15:00:00Z',
      lastOrderAt: null,
      lastOrderRaw: null,
    },
    price: null,
    photos: { photos: [{ photoRef: 'places/A/photos/one', attributions: [], sourceUrl: null }] },
    walkingRoute: null,
    lastTrain: null,
    evidenceIds: [photoObservation.observationId],
    why: photoWhy,
    diff: null,
  },
  alts: [],
};

const photoRegistry = (observation: ReadonlyStoredObservation | undefined) => ({
  readObservation: (_scope: { ownerScopeRef: string; threadId: string }, id: string) =>
    id === observation?.observationId ? observation : undefined,
});

describe('preparePhotoTokens', () => {
  it('builds token input from the committed card and the scoped registry policy', () => {
    const observations = collectPhotoTokenObservations(photoResponse, {
      registry: photoRegistry(photoObservation),
      scope: { ownerScopeRef: CONTEXT.ownerScopeRef, threadId: CONTEXT.threadId },
      now: CONTEXT.now,
      photosEnabled: true,
      displayPolicyFor: () => photoDisplayPolicy(),
    });

    expect(observations).toEqual([
      {
        candidateId: 'candidate-a',
        photoRef: 'places/A/photos/one',
        displayAllowed: true,
        sessionExpiresAt: '2026-09-10T13:00:00Z',
        displayUntil: '2026-09-10T12:30:00Z',
        providerExpiresAt: '2026-09-10T12:25:00Z',
      },
    ]);
  });

  it('fails closed when the photo capability is not explicitly enabled', () => {
    const observations = collectPhotoTokenObservations(photoResponse, {
      registry: photoRegistry(photoObservation),
      scope: { ownerScopeRef: CONTEXT.ownerScopeRef, threadId: CONTEXT.threadId },
      now: CONTEXT.now,
      photosEnabled: false,
      displayPolicyFor: () => photoDisplayPolicy(),
    });

    expect(observations).toEqual([]);
  });

  it('marks stale or policy-withheld registry evidence as non-displayable', () => {
    const observations = collectPhotoTokenObservations(photoResponse, {
      registry: photoRegistry({
        ...photoObservation,
        retention: { ...photoRetention, displayPolicyStatus: 'expired' },
      }),
      scope: { ownerScopeRef: CONTEXT.ownerScopeRef, threadId: CONTEXT.threadId },
      now: CONTEXT.now,
      photosEnabled: true,
      displayPolicyFor: () => photoDisplayPolicy(),
    });

    expect(observations[0]?.displayAllowed).toBe(false);
  });

  it('uses display policy independently from model and persistence retention policy', async () => {
    const observations = collectPhotoTokenObservations(photoResponse, {
      registry: photoRegistry({
        ...photoObservation,
        retention: {
          ...photoRetention,
          retentionDecision: 'deny',
          retentionUntil: null,
          deletionScheduledAt: null,
          restoreMode: 'reference_only',
          policyStatus: 'policy_withheld',
        },
      }),
      scope: { ownerScopeRef: CONTEXT.ownerScopeRef, threadId: CONTEXT.threadId },
      now: CONTEXT.now,
      photosEnabled: true,
      displayPolicyFor: () =>
        photoDisplayPolicy({}, policyRecord({ decision: 'deny', policyStatus: 'policy_withheld' })),
    });

    expect(observations[0]?.displayAllowed).toBe(true);
    const issue = vi.fn(() => Promise.resolve('display-token'));
    const prepared = await preparePhotoTokens(makeCodec(issue), observations, CONTEXT);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(prepared.resolve('candidate-a', 'places/A/photos/one')).toBe('display-token');
  });

  it('withholds when display policy is unknown even if other uses allow the field', () => {
    const observations = collectPhotoTokenObservations(photoResponse, {
      registry: photoRegistry(photoObservation),
      scope: { ownerScopeRef: CONTEXT.ownerScopeRef, threadId: CONTEXT.threadId },
      now: CONTEXT.now,
      photosEnabled: true,
      displayPolicyFor: () => photoDisplayPolicy({ decision: 'unknown' }),
    });

    expect(observations[0]?.displayAllowed).toBe(false);
  });

  it('binds the registry observation batch to the authenticated device before mapping', async () => {
    const issue = vi.fn((input: Parameters<PhotoTokenCodec['issue']>[0]) =>
      Promise.resolve(`issued:${input.photoRef}:${input.deviceId}`),
    );
    const prepare = createPhotoTokenPreparer({
      codec: makeCodec(issue),
      registry: photoRegistry(photoObservation),
      scope: { ownerScopeRef: CONTEXT.ownerScopeRef, threadId: CONTEXT.threadId },
      deviceId: CONTEXT.deviceId,
      sourceTurnId: CONTEXT.sourceTurnId,
      sourceRevision: CONTEXT.sourceRevision,
      photosEnabled: true,
      displayPolicyFor: () => photoDisplayPolicy(),
    });

    const resolver = await prepare({
      response: photoResponse,
      metadata: {
        threadId: CONTEXT.threadId,
        turnId: CONTEXT.sourceTurnId,
        responseId: 'response-photo-preissue',
        revision: 2,
      },
      now: CONTEXT.now,
    });

    expect(issue).toHaveBeenCalledTimes(1);
    expect(issue.mock.calls[0]?.[0].deviceId).toBe(CONTEXT.deviceId);
    expect(issue.mock.calls[0]?.[0].turnId).toBe(CONTEXT.sourceTurnId);
    expect(issue.mock.calls[0]?.[0].revision).toBe(CONTEXT.sourceRevision);
    expect(resolver?.('candidate-a', 'places/A/photos/one')).toContain(CONTEXT.deviceId);
  });

  it('deduplicates observed photos and exposes only the issued lookup values', async () => {
    const issue = vi.fn((input: Parameters<PhotoTokenCodec['issue']>[0]) =>
      Promise.resolve(`issued:${input.photoRef}`),
    );
    const prepared = await preparePhotoTokens(
      makeCodec(issue),
      [
        observation(),
        observation({ displayUntil: '2026-09-10T12:05:00.000Z' }),
        observation({ candidateId: 'candidate-b', photoRef: 'places/B/photos/two' }),
      ],
      CONTEXT,
    );

    expect(issue).toHaveBeenCalledTimes(2);
    expect(prepared.issuedCount).toBe(2);
    expect(prepared.withheldCount).toBe(0);
    expect(issue.mock.calls[0]?.[0].expiresAt).toBe('2026-09-10T12:05:00.000Z');
    expect(prepared.resolve('candidate-a', 'places/A/photos/one')).toBe(
      'issued:places/A/photos/one',
    );
    expect(prepared.resolve('candidate-a', 'places/B/photos/two')).toBeUndefined();
  });

  it('withholds only typed token failures so one photo does not abort the batch', async () => {
    const issue = vi.fn((input: Parameters<PhotoTokenCodec['issue']>[0]) =>
      input.photoRef.endsWith('/bad')
        ? Promise.reject(new PhotoTokenError('REFERENCE_UNAVAILABLE'))
        : Promise.resolve(`issued:${input.photoRef}`),
    );
    const prepared = await preparePhotoTokens(
      makeCodec(issue),
      [
        observation({ photoRef: 'places/A/photos/good' }),
        observation({ photoRef: 'places/A/photos/bad' }),
      ],
      CONTEXT,
    );

    expect(prepared.issuedCount).toBe(1);
    expect(prepared.withheldCount).toBe(1);
    expect(prepared.resolve('candidate-a', 'places/A/photos/good')).toBe(
      'issued:places/A/photos/good',
    );
    expect(prepared.resolve('candidate-a', 'places/A/photos/bad')).toBeUndefined();
  });

  it('does not hide an unexpected implementation failure', async () => {
    const issue = vi.fn(() => Promise.reject(new Error('unexpected provider state')));
    await expect(preparePhotoTokens(makeCodec(issue), [observation()], CONTEXT)).rejects.toThrow(
      'unexpected provider state',
    );
  });

  it('withholds observations that are not displayable or have expired policy bounds', async () => {
    const issue = vi.fn((input: Parameters<PhotoTokenCodec['issue']>[0]) =>
      Promise.resolve(`issued:${input.photoRef}`),
    );
    const prepared = await preparePhotoTokens(
      makeCodec(issue),
      [
        observation({ photoRef: 'places/A/photos/denied', displayAllowed: false }),
        observation({ photoRef: 'places/A/photos/missing-window', displayUntil: null }),
        observation({
          photoRef: 'places/A/photos/expired',
          providerExpiresAt: '2026-09-10T11:59:59.000Z',
        }),
      ],
      CONTEXT,
    );

    expect(issue).not.toHaveBeenCalled();
    expect(prepared.issuedCount).toBe(0);
    expect(prepared.withheldCount).toBe(3);
  });

  it('denies a duplicate when any observation is not displayable', async () => {
    const issue = vi.fn((input: Parameters<PhotoTokenCodec['issue']>[0]) =>
      Promise.resolve(`issued:${input.photoRef}`),
    );
    const prepared = await preparePhotoTokens(
      makeCodec(issue),
      [observation(), observation({ displayAllowed: false })],
      CONTEXT,
    );

    expect(issue).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({ issuedCount: 0, withheldCount: 1 });
  });
});
