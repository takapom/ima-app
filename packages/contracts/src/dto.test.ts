import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  APP_TOKEN_HEADER,
  APP_VERSION_HEADER,
  DEVICE_ID_HEADER,
  LifecycleRouteRequestSchema,
  PhotoBinaryRouteResponseSchema,
  RequestHeadersSchema,
  RouteContracts,
  ThreadReadResponseSchema,
} from './http';
import {
  CreateThreadResponseSchema,
  EventPayloadSchema,
  LocationSnapshotSchema,
  SearchRequestSchema,
  ThreadTurnRequestSchema,
} from './preferences';
import { DisplayFieldSchema } from './public';
import {
  AssistantMessageResponseSchema,
  PhotoResponseDescriptorSchema,
  SearchResponseSchema,
} from './response';
import {
  CardsDataSchema,
  LastTrainInfoSchema,
  LastTrainTransferSchema,
  OpeningIntervalSchema,
  PlaceIdentitySchema,
  PhotoInfoSchema,
  PriceRangeSchema,
  PublicPlaceDetailsDataSchema,
  WalkingRouteSchema,
} from './values';

const timestamp = '2026-09-09T12:00:00Z';
const retention = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T05:00:00+09:00',
  freshUntil: timestamp,
  displayUntil: '2026-09-09T13:00:00Z',
  retentionUntil: '2026-09-10T05:00:00+09:00',
  deletionScheduledAt: '2026-09-10T05:00:00+09:00',
  attribution: { label: 'Example source', sourceLink: 'https://example.com/source' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};
const evidence = {
  evidenceId: 'obs-1',
  attribution: { label: 'Example source', sourceLink: 'https://example.com/source' },
  retention,
};
const message = {
  text: '徒歩で行きやすい候補です',
  evidenceIds: ['obs-1'],
  evidence: [evidence],
  basis: 'grounded',
  retention,
};
const identity = {
  status: 'known',
  value: {
    name: 'Melt',
    area: '恵比寿',
    address: null,
    category: 'cafe',
    businessStatus: 'operational',
    sourceUrl: 'https://example.com/place',
  },
  evidence: [evidence],
};
const card = {
  candidateId: 'candidate-1',
  facts: { identity },
  why: message,
};
const searchRequest = {
  schemaVersion: 'v1',
  requestId: 'request-1',
  threadId: 'thread-1',
  turnId: null,
  revision: 1,
  text: '静かで甘いもの',
  clientNow: timestamp,
  location: {
    status: 'unavailable',
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs: {
    homeStationRef: 'station-shibuya',
    maxWalkMinutes: 15,
    minimumStayMinutes: null,
    areaText: '恵比寿',
    budget: 'normal',
  },
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: 'idem-1',
};
describe('public display and HTTP DTOs', () => {
  it('requires renderable card facts and evidence', () => {
    expect(v.safeParse(CardsDataSchema, { hero: card, alts: [] }).success).toBe(true);
    expect(v.safeParse(CardsDataSchema, { hero: { ...card, facts: {} }, alts: [] }).success).toBe(
      false,
    );
    expect(
      v.safeParse(CardsDataSchema, {
        hero: card,
        alts: [{ ...card, candidateId: 'candidate-1', diff: message }],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(DisplayFieldSchema(PlaceIdentitySchema), {
        ...identity,
        evidence: [],
      }).success,
    ).toBe(false);
  });
  it('keeps details and photos public-safe and strict', () => {
    expect(
      v.safeParse(PublicPlaceDetailsDataSchema, {
        items: [{ candidateId: 'candidate-1', fields: { identity } }],
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(PublicPlaceDetailsDataSchema, {
        items: [{ candidateId: 'candidate-1', fields: { identity, providerRecordId: 'raw' } }],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(PhotoInfoSchema, {
        photos: [
          {
            photoToken: 'photo-token-1',
            attributions: [{ displayName: 'Example', uri: 'https://example.com/source' }],
            sourceUrl: 'https://example.com/photo',
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(PhotoInfoSchema, {
        photos: [{ photoHandle: 'provider/raw', attributions: [], sourceUrl: null }],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(PublicPlaceDetailsDataSchema, {
        items: [
          { candidateId: 'candidate-1', fields: { identity } },
          { candidateId: 'candidate-1', fields: { identity } },
        ],
      }).success,
    ).toBe(false);
  });
  it('rejects impossible dates, intervals, transfers, and non-finite measurements', () => {
    expect(
      v.safeParse(OpeningIntervalSchema, {
        startAt: timestamp,
        endAt: '2026-09-09T11:59:59Z',
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(OpeningIntervalSchema, {
        startAt: timestamp,
        endAt: '2026-09-09T12:00:00Z',
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(LastTrainTransferSchema, {
        fromStationRef: 'station-a',
        toStationRef: 'station-b',
        departureAt: timestamp,
        arrivalAt: '2026-09-09T11:59:59Z',
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(PriceRangeSchema, {
        currency: 'JPY',
        min: Number.POSITIVE_INFINITY,
        max: Number.POSITIVE_INFINITY,
        unit: 'per_person',
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(PriceRangeSchema, {
        currency: 'JPY',
        min: 2_000,
        max: 1_000,
        unit: 'per_person',
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(WalkingRouteSchema, {
        originRef: 'location-1',
        destinationCandidateId: 'candidate-1',
        originRevision: Number.MAX_SAFE_INTEGER + 1,
        evaluatedAt: timestamp,
        durationSeconds: 300,
        distanceMeters: 250,
        warnings: [],
      }).success,
    ).toBe(false);
    const lastTrain = {
      serviceDate: '2024-02-29',
      fromStationRef: 'station-a',
      homeStationRef: 'station-home',
      journeyRef: 'journey-1',
      lastDepartureAt: timestamp,
      arrivesHomeAt: '2026-09-09T13:00:00Z',
      transfers: [],
      placeToStationSeconds: 300,
      arrivePlaceAt: '2026-09-09T12:00:00Z',
      leaveBy: '2026-09-09T12:30:00Z',
      availableStaySeconds: 1_800,
      minimumStayMinutes: 20,
      usable: true,
    };
    expect(v.safeParse(LastTrainInfoSchema, lastTrain).success).toBe(true);
    expect(
      v.safeParse(LastTrainInfoSchema, { ...lastTrain, serviceDate: '2023-02-29' }).success,
    ).toBe(false);
    expect(
      v.safeParse(LastTrainInfoSchema, { ...lastTrain, availableStaySeconds: 1_199 }).success,
    ).toBe(false);
  });

  it('keeps location states paired and measurements finite', () => {
    expect(
      v.safeParse(LocationSnapshotSchema, {
        status: 'available',
        lat: 35.6,
        lng: 139.7,
        accuracyMeters: 80,
        precise: true,
        capturedAt: timestamp,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(LocationSnapshotSchema, {
        status: 'reduced',
        lat: 35.6,
        lng: 139.7,
        accuracyMeters: 500,
        precise: false,
        capturedAt: timestamp,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(LocationSnapshotSchema, {
        status: 'available',
        lat: 35.6,
        lng: null,
        accuracyMeters: 80,
        precise: true,
        capturedAt: timestamp,
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(LocationSnapshotSchema, {
        status: 'unavailable',
        lat: 35.6,
        lng: 139.7,
        accuracyMeters: Number.POSITIVE_INFINITY,
        precise: false,
        capturedAt: null,
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(EventPayloadSchema, {
        eventId: 'event-1',
        name: 'turn_completed',
        occurredAt: timestamp,
        durationMs: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);
  });

  it('accepts raw text with explicit saved prefs and rejects inferred intent fields', () => {
    expect(v.safeParse(SearchRequestSchema, searchRequest).success).toBe(true);
    expect(v.safeParse(SearchRequestSchema, { ...searchRequest, mood: ['quiet'] }).success).toBe(
      false,
    );
    expect(
      v.safeParse(SearchRequestSchema, {
        ...searchRequest,
        prefs: { ...searchRequest.prefs, queryForPlaces: 'derived' },
      }).success,
    ).toBe(false);
    const { threadId: ignoredThreadId, ...turnBody } = searchRequest;
    void ignoredThreadId;
    expect(v.safeParse(ThreadTurnRequestSchema, turnBody).success).toBe(true);
    expect(v.safeParse(ThreadTurnRequestSchema, searchRequest).success).toBe(false);
  });

  it('models server-issued thread workflow and non-duplicated nested metadata', () => {
    expect(
      v.safeParse(CreateThreadResponseSchema, {
        schemaVersion: 'v1',
        requestId: 'request-1',
        threadId: 'thread-server-1',
        revision: 1,
        state: 'active',
      }).success,
    ).toBe(true);
    const response = {
      schemaVersion: 'v1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      responseId: 'response-1',
      revision: 1,
      kind: 'message',
      presentation: 'keep',
      cardSetId: null,
      message: [message],
    };
    expect(v.safeParse(AssistantMessageResponseSchema, response).success).toBe(true);
    expect(
      v.safeParse(SearchResponseSchema, { requestId: 'request-1', response, warnings: [] }).success,
    ).toBe(true);
    expect(
      v.safeParse(ThreadReadResponseSchema, {
        schemaVersion: 'v1',
        requestId: 'request-1',
        threadId: 'thread-1',
        revision: 1,
        active: true,
        responses: [
          {
            turnId: 'turn-1',
            responseId: 'response-1',
            revision: 1,
            kind: 'message',
            presentation: 'keep',
            cardSetId: null,
            message: [message],
            restoreMode: 'full',
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(ThreadReadResponseSchema, {
        schemaVersion: 'v1',
        requestId: 'request-1',
        threadId: 'thread-1',
        revision: 1,
        active: true,
        responses: [
          {
            turnId: 'turn-1',
            responseId: 'response-reference',
            revision: 1,
            kind: 'message',
            presentation: 'keep',
            cardSetId: null,
            restoreMode: 'reference_only',
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(ThreadReadResponseSchema, {
        schemaVersion: 'v1',
        requestId: 'request-1',
        threadId: 'thread-1',
        revision: 1,
        active: true,
        responses: [
          {
            turnId: 'turn-1',
            responseId: 'response-reference',
            revision: 2,
            kind: 'message',
            presentation: 'keep',
            cardSetId: null,
            restoreMode: 'unavailable',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(ThreadReadResponseSchema, {
        schemaVersion: 'v1',
        requestId: 'request-1',
        threadId: 'thread-1',
        revision: 1,
        active: true,
        responses: [
          {
            turnId: 'turn-1',
            responseId: 'response-reference',
            revision: 1,
            kind: 'message',
            presentation: 'keep',
            cardSetId: null,
            restoreMode: 'unavailable',
          },
          {
            turnId: 'turn-1',
            responseId: 'response-reference',
            revision: 1,
            kind: 'message',
            presentation: 'keep',
            cardSetId: null,
            restoreMode: 'unavailable',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('separates photo JSON metadata from binary body and lifecycle paths', () => {
    expect(APP_TOKEN_HEADER).toBe('X-App-Token');
    expect(DEVICE_ID_HEADER).toBe('X-Device-Id');
    expect(APP_VERSION_HEADER).toBe('X-App-Version');
    expect(
      v.safeParse(RequestHeadersSchema, {
        appToken: 'internal-token',
        deviceId: 'device-1',
        ownerCredential: 'A'.repeat(43),
        requestId: 'request-1',
        appVersion: '1.0.0',
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(RequestHeadersSchema, {
        deviceId: 'device-1',
        ownerCredential: 'A'.repeat(43),
        requestId: 'request-1',
        appVersion: '1.0.0',
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(PhotoResponseDescriptorSchema, {
        schemaVersion: 'v1',
        requestId: 'request-1',
        token: 'photo-token-1',
        contentType: 'image/jpeg',
        expiresAt: '2026-09-09T13:00:00Z',
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(PhotoBinaryRouteResponseSchema, {
        bodyKind: 'binary',
        descriptor: {
          schemaVersion: 'v1',
          requestId: 'request-1',
          token: 'photo-token-1',
          contentType: 'image/jpeg',
          expiresAt: '2026-09-09T13:00:00Z',
        },
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(PhotoBinaryRouteResponseSchema, {
        bodyKind: 'json',
        descriptor: {
          schemaVersion: 'v1',
          requestId: 'request-1',
          token: 'photo-token-1',
          contentType: 'image/jpeg',
          expiresAt: '2026-09-09T13:00:00Z',
        },
      }).success,
    ).toBe(false);
    const lifecycle = {
      path: { threadId: 'thread-1' },
      body: {
        schemaVersion: 'v1',
        requestId: 'request-1',
        turnId: 'turn-1',
        revision: 1,
        idempotencyKey: 'idem-1',
      },
    };
    expect(v.safeParse(LifecycleRouteRequestSchema, lifecycle).success).toBe(true);
    expect(RouteContracts.createThread.successStatus).toBe(201);
    expect(RouteContracts.turn.path).toBe('/v1/threads/:threadId/turns');
    expect(RouteContracts.resume.path).toBe('/v1/threads/:threadId/resume');
    expect(RouteContracts.savedReferenceRefresh.path).toBe('/v1/saved/:savedPlaceRef/refresh');
    expect(RouteContracts.prefsRead.path).toBe('/v1/prefs');
    expect(RouteContracts.prefsRead.method).toBe('GET');
    expect(RouteContracts.prefsRead.successStatus).toBe(200);
    expect(RouteContracts.prefsWrite.path).toBe('/v1/prefs');
    expect(RouteContracts.prefsWrite.method).toBe('PUT');
    expect(RouteContracts.prefsWrite.successStatus).toBe(200);
    expect(RouteContracts.savedReferenceList.path).toBe('/v1/saved');
    expect(RouteContracts.savedReferenceList.method).toBe('GET');
    expect(RouteContracts.savedReferenceList.successStatus).toBe(200);
    expect(RouteContracts.placeDecide.path).toBe('/v1/threads/:threadId/decided');
    expect(RouteContracts.placeDecide.method).toBe('POST');
    expect(RouteContracts.placeDecide.successStatus).toBe(201);
  });
});
