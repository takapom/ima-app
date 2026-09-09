import { describe, expect, it } from 'vitest';
import {
  isThreadRuntimeTurnInput,
  responseMetadata,
  responseReference,
  runtimeInputDigest,
  type ThreadRuntimeTarget,
} from '../../src/thread-runtime/admission';

const target: ThreadRuntimeTarget = {
  ownerScopeRef: 'owner-runtime-admission',
  threadId: 'thread-runtime-admission',
  turnId: 'turn-runtime-admission',
  revision: 3,
};

const request = {
  schemaVersion: 'v1' as const,
  requestId: 'request-runtime-admission',
  turnId: target.turnId,
  revision: target.revision,
  text: '静かな店',
  clientNow: '2026-09-10T12:00:00Z',
  location: {
    status: 'unavailable' as const,
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs: {
    homeStationRef: null,
    maxWalkMinutes: 15,
    minimumStayMinutes: null,
    areaText: '恵比寿',
    budget: 'normal' as const,
  },
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search' as const,
  idempotencyKey: 'idempotency-runtime-admission',
};

const publicResponse = {
  schemaVersion: 'v1' as const,
  threadId: target.threadId,
  turnId: target.turnId,
  responseId: 'response-runtime-admission',
  revision: target.revision + 1,
  kind: 'message' as const,
  presentation: 'keep' as const,
  cardSetId: null,
  message: [
    {
      text: '確認しました',
      evidenceIds: [],
      evidence: [],
      basis: 'conversational' as const,
      retention: {
        retentionDecision: 'deny' as const,
        retentionMode: 'session_only' as const,
        sessionExpiresAt: '2026-09-10T16:00:00Z',
        freshUntil: null,
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
        attribution: null,
        restoreMode: 'reference_only' as const,
        policyStatus: 'policy_withheld' as const,
        displayPolicyStatus: 'policy_withheld' as const,
      },
    },
  ],
};

describe('thread runtime admission boundaries', () => {
  it('normalizes object key order before hashing content', async () => {
    const reordered = {
      ...request,
      requestId: 'request-runtime-admission-retry',
      prefs: {
        budget: request.prefs.budget,
        areaText: request.prefs.areaText,
        minimumStayMinutes: request.prefs.minimumStayMinutes,
        maxWalkMinutes: request.prefs.maxWalkMinutes,
        homeStationRef: request.prefs.homeStationRef,
      },
      location: {
        capturedAt: request.location.capturedAt,
        precise: request.location.precise,
        accuracyMeters: request.location.accuracyMeters,
        lng: request.location.lng,
        lat: request.location.lat,
        status: request.location.status,
      },
    };

    expect(await runtimeInputDigest(request)).toBe(await runtimeInputDigest(reordered));
    expect(
      isThreadRuntimeTurnInput({
        ...target,
        idempotencyKey: request.idempotencyKey,
        input: request,
      }),
    ).toBe(true);
  });

  it('requires the target revision and turn to agree with the validated request', () => {
    expect(
      isThreadRuntimeTurnInput({
        ...target,
        idempotencyKey: request.idempotencyKey,
        input: { ...request, revision: target.revision + 1 },
      }),
    ).toBe(false);
    expect(
      isThreadRuntimeTurnInput({
        ...target,
        idempotencyKey: request.idempotencyKey,
        input: { ...request, turnId: 'another-turn' },
      }),
    ).toBe(false);
  });

  it('retains only the public response metadata for reference replay', () => {
    expect(responseMetadata(publicResponse, target)).toEqual({
      turnId: target.turnId,
      responseId: 'response-runtime-admission',
      revision: target.revision + 1,
      kind: 'message',
      presentation: 'keep',
      cardSetId: null,
    });
    expect(responseReference(publicResponse, target)).toEqual({
      turnId: target.turnId,
      responseId: 'response-runtime-admission',
      revision: target.revision + 1,
      kind: 'message',
      presentation: 'keep',
      cardSetId: null,
      restoreMode: 'reference_only',
    });
    expect(responseReference({ ...publicResponse, revision: target.revision }, target)).toBeNull();
  });
});
