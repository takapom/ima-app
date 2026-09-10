import { describe, expect, it } from 'vitest';
import {
  evaluateModelEvidenceAvailability,
  ModelContextError,
  projectModelContext,
} from './model-context';
import type { ModelContextFieldPolicy } from './model-context';

const allowModelContextFieldPolicy: ModelContextFieldPolicy = {
  evidence: {
    identity: 'allow',
    opening_hours: 'allow',
    price: 'allow',
    photos: 'allow',
    contact: 'allow',
    facilities: 'allow',
    walking_route: 'allow',
    last_train: 'allow',
  },
  history: 'allow',
  cardSet: 'allow',
  displayName: 'allow',
};

const harness = {
  threadId: 'thread-1',
  turnId: 'turn-4',
  revision: 4,
  serverNow: '2026-09-10T12:00:00Z',
  ownerScopeRef: 'owner-1',
  location: {
    status: 'available' as const,
    coordinates: { lat: 35.6, lng: 139.7 },
    accuracyMeters: 25,
    precise: true,
    capturedAt: '2026-09-10T11:59:00Z',
    revision: 2,
  },
  preferences: {
    homeStationRef: 'station-shibuya',
    maxWalkMinutes: 15,
    minimumStayMinutes: 30,
    areaText: '恵比寿',
    budget: 'normal' as const,
  },
  budget: {
    wallClockMs: 8_000,
    finalReserveMs: 2_000,
    modelCallsRemaining: 3,
    readCallsRemaining: 6,
    providerHttpRequestsRemaining: 12,
    retriesRemaining: 1,
  },
  capabilities: {
    version: 'places-v1',
    detailFields: ['identity', 'opening_hours'] as const,
    walkingRoute: true,
    lastTrain: true,
    supportedScopes: ['fixture'] as const,
  },
};

const cardSet = {
  record: {
    cardSetId: 'card-set-1',
    scope: { ownerScopeRef: 'owner-1', threadId: 'thread-1' },
    responseId: 'response-1',
    entries: [
      { candidateId: 'candidate-2', displayOrder: 0, role: 'hero' as const },
      { candidateId: 'candidate-1', displayOrder: 1, role: 'alt' as const },
      { candidateId: 'candidate-3', displayOrder: 2, role: 'alt' as const },
    ],
    selectedCandidateId: 'candidate-2',
    excludedCandidateIds: ['candidate-3'],
  },
  candidates: [
    {
      candidateId: 'candidate-1',
      ownerScopeRef: 'owner-1',
      threadId: 'thread-1',
      displayName: '一つ目',
      status: 'operational' as const,
      excluded: false,
    },
    {
      candidateId: 'candidate-2',
      ownerScopeRef: 'owner-1',
      threadId: 'thread-1',
      displayName: '二つ目',
      status: 'operational' as const,
      excluded: false,
    },
    {
      candidateId: 'candidate-3',
      ownerScopeRef: 'owner-1',
      threadId: 'thread-1',
      displayName: '除外店',
      status: 'unknown' as const,
      excluded: true,
    },
  ],
};

const source = {
  harness,
  userText: 'なぜ二つ目？ もう少し近く、静かさは維持して。',
  history: [
    {
      threadId: 'thread-1',
      turnId: 'turn-1',
      role: 'user' as const,
      text: '静かで甘いものがある店',
      evidenceIds: [],
      basis: 'conversational' as const,
    },
    {
      threadId: 'thread-1',
      turnId: 'turn-2',
      role: 'assistant' as const,
      text: '候補を3つ出しました。',
      evidenceIds: ['observation-1'],
      basis: 'grounded' as const,
    },
    {
      threadId: 'thread-1',
      turnId: 'turn-3',
      role: 'user' as const,
      text: '二つ目の理由を教えて',
      evidenceIds: [],
      basis: 'conversational' as const,
    },
  ],
  cardSet,
  conditions: {
    maxWalkMinutes: 15,
    homeStationRef: 'station-shibuya',
    minimumStayMinutes: 30,
  },
  evidence: [
    {
      ownerScopeRef: 'owner-1',
      threadId: 'thread-1',
      observationId: 'observation-1',
      candidateId: 'candidate-2',
      field: 'identity' as const,
      value: {
        name: '二つ目',
        area: '恵比寿',
        address: null,
        category: 'cafe',
        businessStatus: 'operational' as const,
        sourceUrl: null,
      },
      fetchedAt: '2026-09-10T11:55:00Z',
      freshUntil: '2026-09-10T12:30:00Z',
      expiresAt: '2026-09-10T12:45:00Z',
      sources: [{ provider: 'fixture', recordRef: 'record-2', attribution: null, publicUrl: null }],
      retention: {
        retentionDecision: 'allow' as const,
        retentionMode: 'provider_limited' as const,
        sessionExpiresAt: '2026-09-10T13:00:00Z',
        freshUntil: '2026-09-10T12:30:00Z',
        displayUntil: '2026-09-10T12:30:00Z',
        retentionUntil: '2026-09-10T13:00:00Z',
        deletionScheduledAt: '2026-09-10T13:00:00Z',
        attribution: null,
        restoreMode: 'full' as const,
        policyStatus: 'available' as const,
        displayPolicyStatus: 'available' as const,
      },
    },
  ],
  fieldPolicy: allowModelContextFieldPolicy,
  stationDirectory: {
    status: 'available' as const,
    stations: [
      { stationRef: 'station-shibuya', displayName: '渋谷駅' },
      { stationRef: 'station-shinjuku', displayName: '新宿駅' },
    ],
  },
};

const firstEvidence = source.evidence[0];
if (firstEvidence === undefined) throw new Error('fixture evidence missing');

describe('model context projection', () => {
  it('preserves original mixed-intent context while projecting only the allowlist', () => {
    const projected = projectModelContext(source);

    expect(projected.userText).toBe(source.userText);
    expect(projected.history.map((entry) => entry.text)).toEqual([
      '静かで甘いものがある店',
      '候補を3つ出しました。',
      '二つ目の理由を教えて',
    ]);
    expect(projected.cardSet?.entries.map((entry) => entry.candidateId)).toEqual([
      'candidate-2',
      'candidate-1',
      'candidate-3',
    ]);
    expect(projected.cardSet?.candidates.map((candidate) => candidate.displayName)).toEqual([
      '二つ目',
      '一つ目',
      '除外店',
    ]);
    expect(projected.cardSet?.selectedCandidateId).toBe('candidate-2');
    expect(projected.cardSet?.excludedCandidateIds).toEqual(['candidate-3']);
    expect(projected.conditions).toEqual(source.conditions);
    expect(projected.stationDirectory).toEqual(source.stationDirectory);
    const projectedEvidence = projected.evidence[0];
    expect(projectedEvidence?.status).toBe('known');
    if (projectedEvidence?.status !== 'known') throw new Error('expected known evidence');
    expect(projectedEvidence.value).toEqual(source.evidence[0]?.value);

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('ownerScopeRef');
    expect(serialized).not.toContain('coordinates');
    expect(serialized).not.toContain('35.6');
    expect(serialized).not.toContain('139.7');
  });

  it('rejects cross-thread history and unallowlisted evidence properties', () => {
    expect(() =>
      projectModelContext({
        ...source,
        history: [{ ...source.history[0], threadId: 'thread-foreign' }],
      }),
    ).toThrowError(ModelContextError);

    const invalidEvidence = {
      ...firstEvidence,
      value: { ...firstEvidence.value, ownerCredential: 'secret' },
    };
    expect(() => projectModelContext({ ...source, evidence: [invalidEvidence] })).toThrowError(
      ModelContextError,
    );

    expect(() =>
      projectModelContext({
        ...source,
        evidence: [firstEvidence, { ...firstEvidence, candidateId: 'candidate-1' }],
      }),
    ).toThrowError(ModelContextError);
  });

  it('rejects card candidates that do not match current scope or exclusion state', () => {
    expect(() =>
      projectModelContext({
        ...source,
        cardSet: {
          ...cardSet,
          candidates: cardSet.candidates.map((candidate) =>
            candidate.candidateId === 'candidate-2'
              ? { ...candidate, threadId: 'thread-foreign' }
              : candidate,
          ),
        },
      }),
    ).toThrowError(ModelContextError);
  });

  it('projects policy-withheld evidence as metadata instead of a fresh fact', () => {
    const withheld = {
      ...firstEvidence,
      observationId: 'observation-withheld',
      retention: {
        retentionDecision: 'unknown' as const,
        retentionMode: 'session_only' as const,
        sessionExpiresAt: '2026-09-10T13:00:00Z',
        freshUntil: null,
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
        attribution: null,
        restoreMode: 'reference_only' as const,
        policyStatus: 'policy_withheld' as const,
        displayPolicyStatus: 'policy_withheld' as const,
      },
    };
    const projected = projectModelContext({
      ...source,
      fieldPolicy: {
        ...allowModelContextFieldPolicy,
        evidence: { ...allowModelContextFieldPolicy.evidence, identity: 'deny' },
      },
      evidence: [firstEvidence, withheld],
    });
    expect(projected.evidence[1]).toEqual({
      status: 'withheld',
      observationId: 'observation-withheld',
      candidateId: 'candidate-2',
      field: 'identity',
      reason: 'model input policy denies this evidence field',
      freshUntil: '2026-09-10T12:30:00Z',
    });
    expect(JSON.stringify(projected.evidence[1])).not.toContain('二つ目');
  });

  it('does not reintroduce grounded text whose supporting evidence is stale', () => {
    const staleEvidence = {
      ...firstEvidence,
      observationId: 'observation-stale',
      freshUntil: '2026-09-10T12:00:00Z',
      value: { ...firstEvidence.value, name: '古い店舗' },
    };
    const projected = projectModelContext({
      ...source,
      history: [
        ...source.history,
        {
          threadId: 'thread-1',
          turnId: 'turn-5',
          role: 'assistant' as const,
          text: '古い店舗は営業中です。',
          evidenceIds: ['observation-stale'],
          basis: 'grounded' as const,
        },
      ],
      evidence: [firstEvidence, staleEvidence],
    });
    expect(projected.evidence[1]?.status).toBe('stale');
    expect(projected.history.some((entry) => entry.text === '古い店舗は営業中です。')).toBe(false);
    expect(JSON.stringify(projected)).not.toContain('古い店舗');
  });

  it('uses local freshness when policy freshness is unbounded and rejects the exact boundary', () => {
    const noPolicyFreshness = {
      ...firstEvidence,
      retention: { ...firstEvidence.retention, freshUntil: null },
    };
    const available = projectModelContext({ ...source, evidence: [noPolicyFreshness] });
    const availableEvidence = available.evidence[0];
    expect(availableEvidence?.status).toBe('known');

    const localExpired = {
      ...noPolicyFreshness,
      freshUntil: '2026-09-10T12:00:00Z',
    };
    const stale = projectModelContext({ ...source, evidence: [localExpired] }).evidence[0];
    expect(stale?.status).toBe('stale');
  });

  it('withholds evidence at the session, freshness, display, retention, or deletion boundary', () => {
    const policyExpired = {
      ...firstEvidence,
      freshUntil: '2026-09-10T13:00:00Z',
      expiresAt: '2026-09-10T14:00:00Z',
      retention: {
        ...firstEvidence.retention,
        sessionExpiresAt: '2026-09-10T13:00:00Z',
        freshUntil: '2026-09-10T13:00:00Z',
        displayUntil: '2026-09-10T13:00:00Z',
        retentionUntil: '2026-09-10T13:00:00Z',
        deletionScheduledAt: '2026-09-10T13:00:00Z',
      },
    };
    const projected = projectModelContext({
      ...source,
      harness: { ...harness, serverNow: '2026-09-10T13:00:00Z' },
      evidence: [policyExpired],
    });
    expect(projected.evidence[0]?.status).toBe('withheld');
  });

  it('shares the same local and policy freshness decision at each exact boundary', () => {
    const retention = firstEvidence.retention;
    expect(
      evaluateModelEvidenceAvailability({
        now: '2026-09-10T12:00:00Z',
        fetchedAt: firstEvidence.fetchedAt,
        freshUntil: firstEvidence.freshUntil,
        expiresAt: firstEvidence.expiresAt,
        retention,
      }),
    ).toEqual({ status: 'available' });
    expect(
      evaluateModelEvidenceAvailability({
        now: '2026-09-10T12:30:00Z',
        fetchedAt: firstEvidence.fetchedAt,
        freshUntil: firstEvidence.freshUntil,
        expiresAt: firstEvidence.expiresAt,
        retention,
      }),
    ).toEqual({ status: 'withheld', reason: 'evidence retention window has ended' });
    expect(
      evaluateModelEvidenceAvailability({
        now: '2026-09-10T12:00:00Z',
        fetchedAt: firstEvidence.fetchedAt,
        freshUntil: '2026-09-10T12:00:00Z',
        expiresAt: firstEvidence.expiresAt,
        retention: { ...retention, freshUntil: null, displayUntil: null },
      }),
    ).toEqual({ status: 'stale', reason: 'evidence is outside its usable freshness window' });
    expect(
      evaluateModelEvidenceAvailability({
        now: '2026-09-10T12:00:00Z',
        fetchedAt: '2026-09-10T12:01:00Z',
        freshUntil: '2026-09-10T12:30:00Z',
        expiresAt: '2026-09-10T12:45:00Z',
        retention,
      }),
    ).toEqual({ status: 'stale', reason: 'evidence timestamps are invalid' });
    expect(
      evaluateModelEvidenceAvailability({
        now: '2026-09-10T12:00:00Z',
        fetchedAt: firstEvidence.fetchedAt,
        freshUntil: firstEvidence.freshUntil,
        expiresAt: firstEvidence.expiresAt,
        retention: { ...retention, displayUntil: 'NaN' },
      }),
    ).toEqual({ status: 'withheld', reason: 'evidence policy window is invalid' });
    const widerSourceWindow = {
      ...firstEvidence,
      freshUntil: '2026-09-10T12:45:00Z',
      expiresAt: '2026-09-10T13:00:00Z',
      retention: { ...retention, freshUntil: null },
    };
    const projected = projectModelContext({ ...source, evidence: [widerSourceWindow] });
    expect(projected.evidence[0]).toMatchObject({
      status: 'known',
      freshUntil: '2026-09-10T12:45:00Z',
    });
  });

  it('marks a missing station directory as unknown instead of treating an empty list as absence', () => {
    const projected = projectModelContext({
      ...source,
      stationDirectory: { status: 'unknown', reason: 'station capability is not loaded' },
    });
    expect(projected.stationDirectory).toEqual({
      status: 'unknown',
      reason: 'station capability is not loaded',
    });
    expect(JSON.stringify(projected.stationDirectory)).not.toContain('stations":[]');
    expect(() =>
      projectModelContext({
        ...source,
        stationDirectory: { status: 'available', stations: [] },
      }),
    ).toThrowError(ModelContextError);
  });

  it('applies model input policy independently to evidence, history, card set, and names', () => {
    const projected = projectModelContext({
      ...source,
      fieldPolicy: {
        ...allowModelContextFieldPolicy,
        evidence: { ...allowModelContextFieldPolicy.evidence, identity: 'deny' },
        history: 'deny',
        cardSet: 'allow',
        displayName: 'unknown',
      },
    });

    expect(projected.history).toEqual([]);
    expect(projected.cardSet?.candidates.map((candidate) => candidate.displayName)).toEqual([
      '[withheld]',
      '[withheld]',
      '[withheld]',
    ]);
    expect(projected.evidence[0]).toMatchObject({
      status: 'withheld',
      reason: 'model input policy denies this evidence field',
    });
    expect(JSON.stringify(projected.evidence)).not.toContain('二つ目');
  });

  it('fails closed when a caller omits the policy snapshot', () => {
    const projected = projectModelContext({ ...source, fieldPolicy: undefined });

    expect(projected.history).toEqual([]);
    expect(projected.cardSet).toBeNull();
    expect(projected.evidence[0]?.status).toBe('withheld');
    expect(JSON.stringify(projected.evidence)).not.toContain('二つ目');
  });
});
