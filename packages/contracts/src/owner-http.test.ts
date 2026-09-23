import { describe, expect, it } from 'vitest';
import {
  OwnerHttpRouteContracts,
  parsePrefsReadRequest,
  parsePrefsReadResponse,
  parsePrefsWriteRequest,
  parsePrefsWriteResponse,
  parsePlaceDecideRequest,
  parsePlaceDecideResponse,
  parseSavedReferenceListRequest,
  parseSavedReferenceListResponse,
} from '@contracts/owner-http';

const prefs = {
  areaText: '恵比寿',
  budget: 'normal',
};

const unsavedPrefs = {
  schemaVersion: 'v1',
  requestId: 'request-1',
  revision: 0,
  prefs: null,
};

const savedPrefs = {
  schemaVersion: 'v1',
  requestId: 'request-1',
  revision: 1,
  prefs,
};

const writeRequest = {
  schemaVersion: 'v1',
  requestId: 'request-1',
  expectedRevision: 0,
  prefs,
};

const writeResponse = {
  schemaVersion: 'v1',
  requestId: 'request-1',
  revision: 1,
};

const savedList = {
  schemaVersion: 'v1',
  requestId: 'request-1',
  savedPlaceRefs: ['saved-1', 'saved-2'],
};

const refs = (count: number) => Array.from({ length: count }, (_, index) => `saved-${index + 1}`);

describe('owner HTTP contracts', () => {
  it('parses prefs GET/PUT and saved list payloads', () => {
    expect(parsePrefsReadRequest({})).toEqual({ success: true, data: {} });
    expect(parsePrefsReadResponse(unsavedPrefs)).toEqual({ success: true, data: unsavedPrefs });
    expect(parsePrefsReadResponse(savedPrefs)).toEqual({ success: true, data: savedPrefs });
    expect(parsePrefsWriteRequest(writeRequest)).toEqual({ success: true, data: writeRequest });
    expect(parsePrefsWriteResponse(writeResponse)).toEqual({ success: true, data: writeResponse });
    expect(parseSavedReferenceListRequest({})).toEqual({ success: true, data: {} });
    expect(parseSavedReferenceListResponse(savedList)).toEqual({
      success: true,
      data: { ...savedList, decided: [] },
    });
    expect(
      parsePlaceDecideRequest({
        schemaVersion: 'v1',
        requestId: 'request-1',
        candidateId: 'candidate-1',
        revision: 1,
        idempotencyKey: 'decide-1',
      }).success,
    ).toBe(true);
    expect(
      parsePlaceDecideResponse({
        schemaVersion: 'v1',
        requestId: 'request-1',
        candidateId: 'candidate-1',
        savedPlaceRef: 'saved-1',
        decidedAt: '2026-09-12T12:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      parseSavedReferenceListResponse({ ...savedList, savedPlaceRefs: refs(50) }).success,
    ).toBe(true);
  });

  it('rejects extra keys, including stationLabel and provider identity', () => {
    expect(parsePrefsReadRequest({ extra: true }).success).toBe(false);
    expect(parsePrefsReadResponse({ ...unsavedPrefs, extra: true }).success).toBe(false);
    expect(parsePrefsWriteRequest({ ...writeRequest, extra: true }).success).toBe(false);
    expect(parsePrefsWriteResponse({ ...writeResponse, extra: true }).success).toBe(false);
    expect(parseSavedReferenceListRequest({ extra: true }).success).toBe(false);
    expect(parseSavedReferenceListResponse({ ...savedList, extra: true }).success).toBe(false);
    expect(
      parsePrefsWriteRequest({
        ...writeRequest,
        prefs: { ...prefs, stationLabel: '渋谷' },
      }).success,
    ).toBe(false);
    expect(parsePrefsWriteRequest({ ...writeRequest, prefs: null }).success).toBe(false);
    expect(
      parseSavedReferenceListResponse({
        ...savedList,
        provider: 'places',
        recordRef: 'raw',
      }).success,
    ).toBe(false);
  });

  it('allows revision 0 and rejects negative revisions', () => {
    expect(parsePrefsReadResponse(unsavedPrefs).success).toBe(true);
    expect(parsePrefsWriteRequest(writeRequest).success).toBe(true);
    expect(parsePrefsWriteResponse({ ...writeResponse, revision: 0 }).success).toBe(true);
    expect(parsePrefsReadResponse({ ...unsavedPrefs, revision: -1 }).success).toBe(false);
    expect(parsePrefsWriteRequest({ ...writeRequest, expectedRevision: -1 }).success).toBe(false);
    expect(parsePrefsWriteResponse({ ...writeResponse, revision: -1 }).success).toBe(false);
  });

  it('rejects duplicate or oversized savedPlaceRefs', () => {
    expect(
      parseSavedReferenceListResponse({
        ...savedList,
        savedPlaceRefs: ['saved-1', 'saved-1'],
      }).success,
    ).toBe(false);
    expect(
      parseSavedReferenceListResponse({ ...savedList, savedPlaceRefs: refs(51) }).success,
    ).toBe(false);
  });

  it('exposes owner route path, method, and success status', () => {
    expect(OwnerHttpRouteContracts.prefsRead.method).toBe('GET');
    expect(OwnerHttpRouteContracts.prefsRead.path).toBe('/v1/prefs');
    expect(OwnerHttpRouteContracts.prefsRead.successStatus).toBe(200);
    expect(OwnerHttpRouteContracts.prefsWrite.method).toBe('PUT');
    expect(OwnerHttpRouteContracts.prefsWrite.path).toBe('/v1/prefs');
    expect(OwnerHttpRouteContracts.prefsWrite.successStatus).toBe(200);
    expect(OwnerHttpRouteContracts.savedReferenceList.method).toBe('GET');
    expect(OwnerHttpRouteContracts.savedReferenceList.path).toBe('/v1/saved');
    expect(OwnerHttpRouteContracts.savedReferenceList.successStatus).toBe(200);
    expect(OwnerHttpRouteContracts.placeDecide.method).toBe('POST');
    expect(OwnerHttpRouteContracts.placeDecide.path).toBe('/v1/threads/:threadId/decided');
    expect(OwnerHttpRouteContracts.placeDecide.successStatus).toBe(201);
  });
});
