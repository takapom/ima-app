import { describe, expect, it } from 'vitest';
import type {
  GetPlaceDetailsOutput,
  HarnessContext,
  Observation,
  ObservationContext,
  PlaceIdentity,
  Result,
  RetentionMetadata,
  SearchPlacesOutput,
} from '@ima/core';
import type { ModelContextFieldPolicy } from '@ima/core';
import {
  projectDetailsResult,
  projectSearchResult,
} from '@worker/infrastructure/adapters/inbound/tools/projection';
import { createToolRegistry, toolScope } from './registry-fixture';

const context: HarnessContext = {
  threadId: 'thread-tools',
  turnId: 'turn-tools',
  revision: 1,
  serverNow: '2026-09-10T00:00:00Z',
  ownerScopeRef: 'owner-tools',
  location: {
    status: 'unavailable',
    coordinates: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
    revision: 1,
  },
  preferences: {
    homeStationRef: 'station-tools',
    maxWalkMinutes: 15,
    minimumStayMinutes: 20,
    areaText: '渋谷',
    budget: 'normal',
  },
  budget: {
    wallClockMs: 2_000,
    finalReserveMs: 250,
    modelCallsRemaining: 4,
    readCallsRemaining: 5,
    providerHttpRequestsRemaining: 5,
    retriesRemaining: 1,
  },
  capabilities: {
    version: 'tools-v1',
    detailFields: ['identity'],
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['tools-fixture'],
  },
};

const allowedRetention = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-12T00:00:00Z',
  freshUntil: '2026-09-10T12:00:00Z',
  displayUntil: '2026-09-10T13:00:00Z',
  retentionUntil: '2026-09-11T00:00:00Z',
  deletionScheduledAt: '2026-09-11T00:00:00Z',
  attribution: { label: 'secret-retention', sourceLink: 'https://public.example/source' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
} satisfies RetentionMetadata;

const deniedRetention = {
  ...allowedRetention,
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
} satisfies RetentionMetadata;

const modelInputOnlyPolicy: ModelContextFieldPolicy = {
  evidence: {
    identity: 'allow',
    opening_hours: 'deny',
    price: 'deny',
    photos: 'deny',
    contact: 'deny',
    facilities: 'deny',
    walking_route: 'deny',
    last_train: 'deny',
  },
  history: 'deny',
  cardSet: 'deny',
  displayName: 'deny',
};

const observationContext: ObservationContext = {
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
  capabilityVersion: context.capabilities.version,
  locationRevision: context.location.revision,
  originRef: 'gps-secret',
  homeStationRef: context.preferences.homeStationRef,
  minimumStayMinutes: context.preferences.minimumStayMinutes,
  timeContext: 'db-secret',
};

const identity: PlaceIdentity = {
  name: 'Safe fixture',
  area: '渋谷',
  address: null,
  category: 'cafe',
  stationName: null,
  accessText: null,
  businessStatus: 'operational',
  sourceUrl: 'https://public.example/place',
};

const observation = (
  retention: RetentionMetadata,
  value: PlaceIdentity = identity,
  includeContext = true,
): Observation<PlaceIdentity> => ({
  observationId: 'observation-safe',
  candidateId: 'candidate-1',
  field: 'identity',
  value,
  basis: 'provider_reported',
  fetchedAt: '2026-09-09T00:00:00Z',
  sourceUpdatedAt: null,
  expiresAt: '2026-09-11T00:00:00Z',
  freshUntil: '2026-09-10T12:00:00Z',
  contextKey: 'fixture-context',
  ...(includeContext ? { context: observationContext } : {}),
  sources: [
    {
      provider: 'fixture',
      recordRef: 'db-secret',
      attribution: 'public-source',
      publicUrl: 'https://public.example/source',
    },
  ],
  retention,
});

const detailsResult = (
  retention: RetentionMetadata,
  value: PlaceIdentity = identity,
): Result<GetPlaceDetailsOutput> => ({
  status: 'ok',
  data: {
    items: [
      {
        candidateId: 'candidate-1',
        fields: { identity: { status: 'known', observations: [observation(retention, value)] } },
      },
    ],
  },
  warnings: [],
});

const unknownDetailsResult: Result<GetPlaceDetailsOutput> = {
  status: 'ok',
  data: {
    items: [
      {
        candidateId: 'candidate-1',
        fields: { identity: { status: 'unknown', reason: 'provider has no identity value' } },
      },
    ],
  },
  warnings: [],
};

const registryFor = (
  storedResult: Result<GetPlaceDetailsOutput>,
): ReturnType<typeof createToolRegistry>['registry'] => {
  const fixture = createToolRegistry();
  if (storedResult.status !== 'error') {
    const identityResult = storedResult.data.items[0]?.fields.identity;
    if (identityResult?.status === 'known') {
      for (const observation of identityResult.observations) {
        if (observation.context === undefined || observation.freshUntil === undefined) {
          throw new Error('fixture observation requires registry context and freshness');
        }
        fixture.registry.registerObservation({
          scope: toolScope,
          candidateId: observation.candidateId,
          field: observation.field,
          value: observation.value,
          basis: observation.basis,
          sourceUpdatedAt: observation.sourceUpdatedAt,
          freshUntil: observation.freshUntil,
          expiresAt: observation.expiresAt,
          context: observation.context,
          sources: observation.sources,
          retention: observation.retention,
        });
      }
    }
  }
  return fixture.registry;
};

const searchResultFor = (candidateId: string): Result<SearchPlacesOutput> => ({
  status: 'ok',
  data: {
    searchId: 'search-1',
    candidates: [
      {
        candidateId,
        identity: { status: 'unknown', reason: 'fixture has no identity value' },
        openingHours: { status: 'unknown', reason: 'fixture has no opening hours value' },
        price: { status: 'unknown', reason: 'fixture has no price value' },
      },
    ],
    applied: { areaDescription: '渋谷', openNow: true, excludedCount: 0 },
    nextCursor: null,
    coverage: 'provider_results',
  },
  warnings: [],
});

describe('model-facing tool projection', () => {
  it('rebuilds an allowlisted observation without internal context, retention, or record refs', () => {
    const returned = detailsResult(allowedRetention);
    const result = projectDetailsResult(
      returned,
      context,
      registryFor(returned),
      context.serverNow,
      modelInputOnlyPolicy,
    );

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const field = result.data.items[0]?.fields.identity;
      expect(field?.status).toBe('known');
      if (field?.status === 'known') {
        const safe = field.observations[0];
        expect(safe).toMatchObject({
          observationId: 'observation-safe',
          candidateId: 'candidate-1',
          field: 'identity',
          value: identity,
          freshUntil: '2026-09-10T12:00:00Z',
          sources: [
            {
              provider: 'fixture',
              attribution: 'public-source',
              publicUrl: 'https://public.example/source',
            },
          ],
        });
        expect(safe).not.toHaveProperty('context');
        expect(safe).not.toHaveProperty('retention');
        expect(safe?.sources[0]).not.toHaveProperty('recordRef');
      }
    }
    expect(JSON.stringify(result)).not.toContain('gps-secret');
    expect(JSON.stringify(result)).not.toContain('db-secret');
    expect(JSON.stringify(result)).not.toContain('secret-retention');
  });

  it('fails closed when the model input field policy is omitted', () => {
    const returned = detailsResult(allowedRetention);
    const result = projectDetailsResult(
      returned,
      context,
      registryFor(returned),
      context.serverNow,
    );

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.items[0]?.fields.identity).toEqual({
        status: 'withheld',
        reason: 'evidence policy does not allow model input',
      });
    }
    expect(JSON.stringify(result)).not.toContain('Safe fixture');
  });

  it('allows only an explicitly permitted llm_input field when display and persistence are denied', () => {
    const returned = detailsResult(deniedRetention);
    const result = projectDetailsResult(
      returned,
      context,
      registryFor(returned),
      context.serverNow,
      modelInputOnlyPolicy,
    );

    expect(result).toMatchObject({
      status: 'ok',
      data: { items: [{ fields: { identity: { status: 'known' } } }] },
    });
    if (result.status === 'ok') {
      expect(result.data.items[0]?.fields.identity).toMatchObject({
        status: 'known',
        observations: [{ value: identity }],
      });
    }
  });

  it('uses the registry snapshot when a provider reuses an observation ID', () => {
    const stored = detailsResult(allowedRetention);
    const forgedIdentity = { ...identity, name: 'forged provider value' };
    const returned = detailsResult(allowedRetention, forgedIdentity);
    const result = projectDetailsResult(
      returned,
      context,
      registryFor(stored),
      context.serverNow,
      modelInputOnlyPolicy,
    );

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.items[0]?.fields.identity).toMatchObject({
        status: 'error',
        error: {
          code: 'INVALID_EVIDENCE',
          path: 'observations.value',
        },
      });
    }
    expect(JSON.stringify(result)).not.toContain('forged provider value');
  });

  it('returns a context error when the provider omits its ownership context', () => {
    const stored = detailsResult(allowedRetention);
    const returned: Result<GetPlaceDetailsOutput> = {
      status: 'ok',
      data: {
        items: [
          {
            candidateId: 'candidate-1',
            fields: {
              identity: {
                status: 'known',
                observations: [observation(allowedRetention, identity, false)],
              },
            },
          },
        ],
      },
      warnings: [],
    };
    const result = projectDetailsResult(returned, context, registryFor(stored), context.serverNow);

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.items[0]?.fields.identity).toMatchObject({
        status: 'error',
        error: {
          code: 'MISSING_CONTEXT',
          path: 'observations.context',
        },
      });
    }
  });

  it('keeps an explicit provider unknown separate from missing registry evidence', () => {
    const unknown = projectDetailsResult(
      unknownDetailsResult,
      context,
      createToolRegistry().registry,
      context.serverNow,
    );
    expect(unknown).toMatchObject({
      status: 'ok',
      data: {
        items: [{ fields: { identity: { status: 'unknown' } } }],
      },
    });

    const unregistered = detailsResult(allowedRetention);
    const missing = projectDetailsResult(
      unregistered,
      context,
      createToolRegistry().registry,
      context.serverNow,
    );
    expect(missing).toMatchObject({
      status: 'ok',
      data: {
        items: [
          {
            fields: {
              identity: {
                status: 'error',
                error: { code: 'MISSING_EVIDENCE', path: 'observations.observationId' },
              },
            },
          },
        ],
      },
    });

    const unavailableFixture = createToolRegistry();
    const unavailable = projectDetailsResult(
      unregistered,
      context,
      {
        readCandidate: unavailableFixture.registry.readCandidate.bind(unavailableFixture.registry),
        readObservation: () => {
          throw new Error('registry read failed');
        },
      },
      context.serverNow,
    );
    expect(unavailable).toMatchObject({
      status: 'ok',
      data: {
        items: [
          {
            fields: {
              identity: {
                status: 'error',
                error: { code: 'MISSING_CONTEXT', path: 'observations' },
              },
            },
          },
        ],
      },
    });
  });

  it('rejects search output for a candidate outside the registry scope', () => {
    const fixture = createToolRegistry();
    const result = projectSearchResult(
      searchResultFor(fixture.otherThreadCandidateId),
      context,
      fixture.registry,
      context.serverNow,
    );

    expect(result).toMatchObject({
      status: 'error',
      error: {
        code: 'UNKNOWN_CANDIDATE',
        path: 'result.candidates.candidateId',
      },
    });
  });

  it('uses the post-read clock for future observations and expiry', () => {
    const returned = detailsResult(allowedRetention);
    const registry = registryFor(returned);
    const beforeRead = { ...context, serverNow: '2026-09-09T23:59:00Z' };
    const known = projectDetailsResult(
      returned,
      beforeRead,
      registry,
      '2026-09-10T00:01:00Z',
      modelInputOnlyPolicy,
    );
    expect(known).toMatchObject({
      status: 'ok',
      data: { items: [{ fields: { identity: { status: 'known' } } }] },
    });

    const shortRetention = { ...allowedRetention, freshUntil: '2026-09-10T12:30:00Z' };
    const shortReturned = detailsResult(shortRetention);
    const expired = projectDetailsResult(
      shortReturned,
      beforeRead,
      registryFor(shortReturned),
      '2026-09-10T12:00:00Z',
    );
    expect(expired).toMatchObject({
      status: 'ok',
      data: { items: [{ fields: { identity: { status: 'stale' } } }] },
    });
  });
});
