import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  DetailsRequestSchema,
  GetPlaceDetailsInputSchema,
  GetPlaceDetailsOutputSchema,
  matchesDetailsRequest,
  SearchPlacesInputSchema,
  SearchPlacesOutputSchema,
} from '@worker/application/ports/operations';
import {
  ModelDecisionSchema,
  ModelRequestSchema,
  SubmitCardsInputSchema,
} from '@worker/application/ports/model';
import {
  SubmitCardsCommittedSchema,
  SubmitCardsPortInputSchema,
  SubmitCardsPortResultSchema,
} from '@worker/application/ports/submission';
import {
  LocationContextSchema,
  ToolExecutionContextSchema,
} from '@worker/application/ports/context';

const modelContext = {
  threadId: 'thread-1',
  turnId: 'turn-1',
  revision: 1,
  serverNow: '2026-09-09T12:00:00Z',
  location: {
    status: 'unavailable',
    areaDescription: '恵比寿',
    accuracyMeters: null,
    capturedAt: null,
    precise: false,
  },
  preferences: {
    areaText: '恵比寿',
    budget: 'normal',
  },
  capabilities: {
    version: 'fixture-v1',
    detailFields: ['identity'],
    supportedScopes: ['fixture'],
  },
};

const search = {
  mode: 'search',
  query: '静かなカフェ',
  area: { kind: 'current_location', radiusMeters: 100 },
  limit: 1,
  excludeCandidateIds: [],
};

const details = {
  requests: [{ candidateId: 'candidate-1', fields: ['identity'] }],
  freshness: 'refresh',
};

const conversational = '候補です' as const;

describe('core port contracts', () => {
  it('keeps search and continue as a strict union with bounded radius', () => {
    expect(v.safeParse(SearchPlacesInputSchema, search).success).toBe(true);
    expect(
      v.safeParse(SearchPlacesInputSchema, {
        ...search,
        area: { kind: 'current_location', radiusMeters: 3_000 },
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(SearchPlacesInputSchema, {
        ...search,
        area: { kind: 'current_location', radiusMeters: 99 },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(SearchPlacesInputSchema, { mode: 'continue', cursor: 'cursor-1' }).success,
    ).toBe(true);
    expect(
      v.safeParse(SearchPlacesInputSchema, {
        mode: 'continue',
        cursor: 'cursor-1',
        query: '再検索',
      }).success,
    ).toBe(false);
    expect(v.safeParse(SearchPlacesInputSchema, { ...search, unexpected: true }).success).toBe(
      false,
    );
  });

  it('requires details fields and unique candidates', () => {
    expect(
      v.safeParse(DetailsRequestSchema, {
        candidateId: 'candidate-1',
        fields: ['identity', 'price'],
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(DetailsRequestSchema, {
        candidateId: 'candidate-1',
        fields: ['identity', 'identity'],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(DetailsRequestSchema, { candidateId: 'candidate-1', fields: ['unknown'] })
        .success,
    ).toBe(false);
    expect(v.safeParse(GetPlaceDetailsInputSchema, details).success).toBe(true);
    expect(
      v.safeParse(GetPlaceDetailsInputSchema, {
        ...details,
        requests: [details.requests[0], details.requests[0]],
      }).success,
    ).toBe(false);
  });

  it('rejects saved references on the details boundary', () => {
    expect(
      v.safeParse(GetPlaceDetailsInputSchema, {
        requests: [{ savedPlaceRef: 'saved-1', fields: ['identity'] }],
        freshness: 'refresh',
      }).success,
    ).toBe(false);
  });

  it('allows multiple model reads in one decision without exposing harness secrets', () => {
    const decision = {
      actions: [
        { kind: 'search_places', input: search },
        { kind: 'get_place_details', input: details },
      ],
    };
    expect(v.safeParse(ModelDecisionSchema, decision).success).toBe(true);
    expect(
      v.safeParse(ModelDecisionSchema, {
        ...decision,
        actions: [
          ...decision.actions,
          {
            kind: 'final_message',
            message: conversational,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(ModelDecisionSchema, {
        ...decision,
        actions: [{ ...decision.actions[0], callId: 'model-chosen' }],
      }).success,
    ).toBe(false);
    const request = { userText: '静かな店', context: modelContext };
    expect(v.safeParse(ModelRequestSchema, request).success).toBe(true);
    expect(
      v.safeParse(ModelRequestSchema, { ...request, ownerScopeRef: 'owner-secret' }).success,
    ).toBe(false);
    expect(
      v.safeParse(ModelRequestSchema, {
        ...request,
        context: { ...modelContext, coordinates: { lat: 1, lng: 2 } },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(ModelDecisionSchema, { ...decision, action: decision.actions[0] }).success,
    ).toBe(false);
    expect(
      v.safeParse(ToolExecutionContextSchema, {
        callId: 'call-1',
        operation: 'search_places',
        threadId: 'thread-1',
        turnId: 'turn-1',
        revision: 1,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(LocationContextSchema, {
        status: 'denied',
        coordinates: { lat: 35.6, lng: 139.7 },
        accuracyMeters: 500,
        precise: false,
        capturedAt: '2026-09-09T12:00:00Z',
        revision: 1,
      }).success,
    ).toBe(false);
  });

  it('validates submit shape and explicit terminal display contract', () => {
    const cards = {
      message: [conversational],
      hero: { candidateId: 'candidate-1', why: conversational },
      alts: [{ candidateId: 'candidate-2', why: conversational, diff: conversational }],
    };
    expect(v.safeParse(SubmitCardsInputSchema, cards).success).toBe(true);
    expect(
      v.safeParse(SubmitCardsInputSchema, { ...cards, hero: { ...cards.hero, evidenceIds: [] } })
        .success,
    ).toBe(false);
    expect(
      v.safeParse(SubmitCardsInputSchema, {
        ...cards,
        alts: [{ ...cards.alts[0], diff: undefined }],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(SubmitCardsInputSchema, {
        ...cards,
        alts: [{ ...cards.alts[0], candidateId: 'candidate-1' }],
      }).success,
    ).toBe(false);
    const portInput = cards;
    expect(v.safeParse(SubmitCardsPortInputSchema, portInput).success).toBe(true);
    expect(
      v.safeParse(SubmitCardsPortInputSchema, { ...portInput, ownerScopeRef: 'secret' }).success,
    ).toBe(false);
    expect(
      v.safeParse(SubmitCardsCommittedSchema, {
        status: 'committed',
        responseId: 'response-1',
        revision: 1,
        presentation: 'replace',
        cards,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(SubmitCardsPortResultSchema, {
        status: 'invalid',
        issues: [
          {
            code: 'MISSING_EVIDENCE',
            path: 'hero.why',
            message: '根拠が必要',
            missingFields: ['evidenceIds'],
          },
        ],
        repairable: true,
        remainingRepairs: 2,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(SubmitCardsPortResultSchema, {
        status: 'invalid',
        issues: [
          {
            code: 'MISSING_EVIDENCE',
            path: 'hero.why',
            message: '上限到達',
            missingFields: ['evidenceIds'],
          },
        ],
        repairable: false,
        remainingRepairs: 0,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(SubmitCardsPortResultSchema, {
        status: 'invalid',
        issues: [{ code: 'STALE_TURN', path: null, message: 'turn expired', missingFields: [] }],
        repairable: true,
        remainingRepairs: 1,
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(SubmitCardsPortResultSchema, {
        status: 'invalid',
        issues: [
          { code: 'BUDGET_EXCEEDED', path: null, message: 'budget exhausted', missingFields: [] },
        ],
        repairable: true,
        remainingRepairs: 1,
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(SubmitCardsPortResultSchema, {
        status: 'invalid',
        issues: [
          { code: 'BUDGET_EXCEEDED', path: null, message: 'budget exhausted', missingFields: [] },
        ],
        repairable: false,
        remainingRepairs: 0,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(SubmitCardsPortResultSchema, {
        status: 'invalid',
        issues: [
          { code: 'MISSING_EVIDENCE', path: null, message: 'still missing', missingFields: [] },
        ],
        repairable: true,
        remainingRepairs: 0,
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(SubmitCardsPortResultSchema, {
        status: 'committed',
        revision: 1,
        presentation: 'replace',
        cards,
      }).success,
    ).toBe(false);
  });

  it('rejects field observations attached to another candidate or field', () => {
    const observation = {
      observationId: 'observation-1',
      candidateId: 'candidate-1',
      field: 'identity',
      value: {
        name: 'Melt',
        area: '恵比寿',
        address: null,
        category: 'cafe',
        stationName: null,
        accessText: null,
        businessStatus: 'operational',
        sourceUrl: 'https://example.com/place',
      },
      basis: 'provider_reported',
      fetchedAt: '2026-09-09T12:00:00Z',
      sourceUpdatedAt: null,
      expiresAt: '2026-09-09T13:00:00Z',
      contextKey: 'thread-1:identity',
      sources: [{ provider: 'fixture', recordRef: 'record-1', attribution: null, publicUrl: null }],
      retention: {
        retentionDecision: 'unknown',
        retentionMode: 'provider_limited',
        sessionExpiresAt: '2026-09-09T13:00:00Z',
        freshUntil: '2026-09-09T12:30:00Z',
        displayUntil: '2026-09-09T12:30:00Z',
        retentionUntil: null,
        deletionScheduledAt: null,
        attribution: null,
        restoreMode: 'reference_only',
        policyStatus: 'policy_withheld',
        displayPolicyStatus: 'available',
      },
    };
    const candidate = {
      candidateId: 'candidate-1',
      identity: { status: 'known', observations: [observation] },
      openingHours: { status: 'unknown', reason: 'not requested' },
      price: { status: 'unsupported', reason: 'fixture' },
      facilities: { status: 'unsupported', reason: 'fixture' },
    };
    const output = {
      searchId: 'search-1',
      candidates: [candidate],
      applied: { areaDescription: '恵比寿', excludedCount: 0 },
      nextCursor: null,
      coverage: 'provider_results',
    };
    expect(v.safeParse(SearchPlacesOutputSchema, output).success).toBe(true);
    expect(
      v.safeParse(SearchPlacesOutputSchema, {
        ...output,
        candidates: [{ ...candidate, candidateId: 'candidate-2' }],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(GetPlaceDetailsOutputSchema, {
        items: [{ candidateId: 'candidate-1', fields: { identity: candidate.identity } }],
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(GetPlaceDetailsOutputSchema, {
        items: [{ candidateId: 'candidate-1', fields: { price: candidate.identity } }],
      }).success,
    ).toBe(false);
    const detailsOutput = {
      items: [{ candidateId: 'candidate-1', fields: { identity: candidate.identity } }],
    };
    expect(matchesDetailsRequest(details, detailsOutput)).toBe(true);
    expect(
      matchesDetailsRequest(
        { ...details, requests: [{ candidateId: 'candidate-1', fields: ['identity', 'price'] }] },
        detailsOutput,
      ),
    ).toBe(false);
    expect(
      matchesDetailsRequest(details, {
        items: [{ candidateId: 'candidate-2', fields: { identity: candidate.identity } }],
      }),
    ).toBe(false);
  });
});
