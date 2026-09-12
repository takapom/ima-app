import * as v from 'valibot';
import {
  IsoTimestampSchema,
  OpaqueIdSchema,
  RequestIdSchema,
  RevisionSchema,
  SchemaVersionSchema,
} from './common';
import { PreferencesSchema } from './preferences';
import type { ParseResult } from './response';
import {
  SavedReferenceCreateRequestSchema,
  type SavedReferenceCreateRequest,
} from './saved-reference-http';

/** Owner prefs start at revision 0 because nothing may be stored yet. */
export const OwnerPrefsRevisionSchema = v.union([v.literal(0), RevisionSchema]);

export const PrefsReadRequestSchema = v.strictObject({});
export type PrefsReadRequest = v.InferOutput<typeof PrefsReadRequestSchema>;

export const PrefsReadResponseSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  revision: OwnerPrefsRevisionSchema,
  prefs: v.nullable(PreferencesSchema),
});
export type PrefsReadResponse = v.InferOutput<typeof PrefsReadResponseSchema>;

export const PrefsWriteRequestSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  expectedRevision: OwnerPrefsRevisionSchema,
  prefs: PreferencesSchema,
});
export type PrefsWriteRequest = v.InferOutput<typeof PrefsWriteRequestSchema>;

export const PrefsWriteResponseSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  revision: OwnerPrefsRevisionSchema,
});
export type PrefsWriteResponse = v.InferOutput<typeof PrefsWriteResponseSchema>;

export const SavedReferenceListRequestSchema = v.strictObject({});
export type SavedReferenceListRequest = v.InferOutput<typeof SavedReferenceListRequestSchema>;

const SavedPlaceRefsSchema = v.pipe(
  v.array(OpaqueIdSchema),
  v.maxLength(50),
  v.check(
    (savedPlaceRefs) => new Set(savedPlaceRefs).size === savedPlaceRefs.length,
    'saved place refs must be unique',
  ),
);

export const PlaceDecideEntrySchema = v.strictObject({
  savedPlaceRef: OpaqueIdSchema,
  decidedAt: IsoTimestampSchema,
});
export type PlaceDecideEntry = v.InferOutput<typeof PlaceDecideEntrySchema>;

const PlaceDecideListSchema = v.pipe(
  v.array(PlaceDecideEntrySchema),
  v.maxLength(50),
  v.check((decided) => {
    const refs = decided.map((entry) => entry.savedPlaceRef);
    return new Set(refs).size === refs.length;
  }, 'decided refs must be unique'),
);

/** Opaque saved refs only; provider identity and coordinates stay off this list. */
export const SavedReferenceListResponseSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  savedPlaceRefs: SavedPlaceRefsSchema,
  decided: v.optional(PlaceDecideListSchema, []),
});
export type SavedReferenceListResponse = v.InferOutput<typeof SavedReferenceListResponseSchema>;

/** Decide reuses the save request; the Worker resolves identity from the current thread. */
export const PlaceDecideRequestSchema = SavedReferenceCreateRequestSchema;
export type PlaceDecideRequest = SavedReferenceCreateRequest;

export const PlaceDecideResponseSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  candidateId: OpaqueIdSchema,
  savedPlaceRef: OpaqueIdSchema,
  decidedAt: IsoTimestampSchema,
});
export type PlaceDecideResponse = v.InferOutput<typeof PlaceDecideResponseSchema>;

const parseSchema = <Schema extends v.GenericSchema>(
  schema: Schema,
  input: unknown,
): ParseResult<v.InferOutput<Schema>> => {
  const parsed = v.safeParse(schema, input);
  return parsed.success
    ? { success: true, data: parsed.output }
    : { success: false, issues: parsed.issues.map((issue) => issue.message) };
};

export const parsePrefsReadRequest = (input: unknown): ParseResult<PrefsReadRequest> =>
  parseSchema(PrefsReadRequestSchema, input);

export const parsePrefsReadResponse = (input: unknown): ParseResult<PrefsReadResponse> =>
  parseSchema(PrefsReadResponseSchema, input);

export const parsePrefsWriteRequest = (input: unknown): ParseResult<PrefsWriteRequest> =>
  parseSchema(PrefsWriteRequestSchema, input);

export const parsePrefsWriteResponse = (input: unknown): ParseResult<PrefsWriteResponse> =>
  parseSchema(PrefsWriteResponseSchema, input);

export const parseSavedReferenceListRequest = (
  input: unknown,
): ParseResult<SavedReferenceListRequest> => parseSchema(SavedReferenceListRequestSchema, input);

export const parseSavedReferenceListResponse = (
  input: unknown,
): ParseResult<SavedReferenceListResponse> => parseSchema(SavedReferenceListResponseSchema, input);

export const parsePlaceDecideRequest = (input: unknown): ParseResult<PlaceDecideRequest> =>
  parseSchema(PlaceDecideRequestSchema, input);

export const parsePlaceDecideResponse = (input: unknown): ParseResult<PlaceDecideResponse> =>
  parseSchema(PlaceDecideResponseSchema, input);

export const OwnerHttpRouteContracts = {
  prefsRead: {
    method: 'GET',
    path: '/v1/prefs',
    request: PrefsReadRequestSchema,
    response: PrefsReadResponseSchema,
    successStatus: 200,
  },
  prefsWrite: {
    method: 'PUT',
    path: '/v1/prefs',
    request: PrefsWriteRequestSchema,
    response: PrefsWriteResponseSchema,
    successStatus: 200,
  },
  savedReferenceList: {
    method: 'GET',
    path: '/v1/saved',
    request: SavedReferenceListRequestSchema,
    response: SavedReferenceListResponseSchema,
    successStatus: 200,
  },
  placeDecide: {
    method: 'POST',
    path: '/v1/threads/:threadId/decided',
    request: PlaceDecideRequestSchema,
    response: PlaceDecideResponseSchema,
    successStatus: 201,
  },
} as const;
