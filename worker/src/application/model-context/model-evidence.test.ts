import { describe, expect, it } from 'vitest';
import { projectModelContext } from '@worker/application/model-context/model-context';
import {
  projectModelEvidence,
  projectModelEvidenceForLlmInput,
} from '@worker/application/model-context/model-evidence';

/** The field is denied for persistence/display, while this unit explicitly permits LLM input. */
const LLM_INPUT_ONLY_RETENTION = {
  retentionDecision: 'deny' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: '2026-09-10T23:00:00Z',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only' as const,
  policyStatus: 'policy_withheld' as const,
  displayPolicyStatus: 'policy_withheld' as const,
};

const evidence = {
  ownerScopeRef: 'owner-evidence',
  threadId: 'thread-evidence',
  observationId: 'observation-evidence',
  candidateId: 'candidate-evidence',
  field: 'identity' as const,
  value: {
    name: 'LLM only cafe',
    area: '渋谷',
    address: null,
    category: 'cafe',
    stationName: null,
    accessText: null,
    businessStatus: 'operational' as const,
    sourceUrl: null,
  },
  fetchedAt: '2026-09-10T12:00:00Z',
  freshUntil: '2026-09-10T18:00:00Z',
  expiresAt: '2026-09-11T02:00:00Z',
  sources: [
    { provider: 'fixture', recordRef: 'record-evidence', attribution: null, publicUrl: null },
  ],
  retention: LLM_INPUT_ONLY_RETENTION,
};

describe('LLM evidence use boundary', () => {
  it('keeps llm_input independent from denied display and persistence policy', () => {
    expect(projectModelEvidenceForLlmInput(evidence, '2026-09-10T15:00:00Z')).toMatchObject({
      status: 'known',
      value: evidence.value,
      freshUntil: '2026-09-10T18:00:00Z',
    });
    expect(projectModelEvidence(evidence, '2026-09-10T15:00:00Z')).toMatchObject({
      status: 'withheld',
    });
  });

  it('still applies field policy and provider/session/deletion freshness bounds', () => {
    const base = {
      harness: {
        ownerScopeRef: evidence.ownerScopeRef,
        threadId: evidence.threadId,
        turnId: 'turn-evidence',
        revision: 1,
        serverNow: '2026-09-10T15:00:00Z',
        location: {
          status: 'unavailable' as const,
          coordinates: null,
          accuracyMeters: null,
          precise: false,
          capturedAt: null,
          revision: 1,
        },
        preferences: {
          homeStationRef: null,
          maxWalkMinutes: null,
          minimumStayMinutes: null,
          areaText: null,
          budget: 'normal' as const,
        },
        budget: {
          wallClockMs: 1000,
          finalReserveMs: 100,
          modelCallsRemaining: 1,
          readCallsRemaining: 1,
          providerHttpRequestsRemaining: 1,
          retriesRemaining: 0,
        },
        capabilities: {
          version: 'evidence-test',
          detailFields: ['identity'] as const,
          walkingRoute: false,
          lastTrain: false,
          supportedScopes: ['evidence-test'],
        },
      },
      userText: 'show evidence',
      history: [],
      cardSet: null,
      evidence: [evidence],
      fieldPolicy: {
        evidence: {
          identity: 'deny' as const,
          opening_hours: 'deny' as const,
          price: 'deny' as const,
          photos: 'deny' as const,
          contact: 'deny' as const,
          facilities: 'deny' as const,
          walking_route: 'deny' as const,
          last_train: 'deny' as const,
        },
        history: 'deny' as const,
        cardSet: 'deny' as const,
        displayName: 'deny' as const,
      },
    };
    expect(projectModelContext(base).evidence[0]?.status).toBe('withheld');
    expect(projectModelEvidenceForLlmInput(evidence, '2026-09-10T18:00:00Z').status).toBe('stale');
    expect(
      projectModelEvidenceForLlmInput(
        {
          ...evidence,
          retention: { ...LLM_INPUT_ONLY_RETENTION, sessionExpiresAt: '2026-09-10T17:00:00Z' },
        },
        '2026-09-10T17:00:00Z',
      ).status,
    ).toBe('withheld');
    const providerExpired = projectModelEvidenceForLlmInput(
      {
        ...evidence,
        freshUntil: '2026-09-11T01:00:00Z',
        expiresAt: '2026-09-11T02:00:00Z',
        retention: { ...LLM_INPUT_ONLY_RETENTION, sessionExpiresAt: '2026-09-12T00:00:00Z' },
      },
      '2026-09-11T02:00:00Z',
    );
    expect(providerExpired).toMatchObject({ status: 'stale' });

    const deletionExpired = projectModelEvidenceForLlmInput(
      {
        ...evidence,
        freshUntil: '2026-09-10T22:00:00Z',
        expiresAt: '2026-09-10T23:00:00Z',
        retention: {
          retentionDecision: 'allow',
          retentionMode: 'provider_limited',
          sessionExpiresAt: '2026-09-10T23:00:00Z',
          freshUntil: '2026-09-10T22:00:00Z',
          displayUntil: '2026-09-10T22:00:00Z',
          retentionUntil: '2026-09-10T22:00:00Z',
          deletionScheduledAt: '2026-09-10T19:30:00Z',
          attribution: null,
          restoreMode: 'full',
          policyStatus: 'available',
          displayPolicyStatus: 'available',
        },
      },
      '2026-09-10T19:30:00Z',
    );
    expect(deletionExpired).toMatchObject({ status: 'withheld' });
  });
});
