import * as v from 'valibot';
import {
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  RequestIdSchema,
  SchemaVersionSchema,
  Text,
} from '@contracts/common';

const LegacyMinutesSchema = v.nullable(
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(180)),
);

/**
 * App builds released before walking and last-train conditions were removed (#55) still send
 * these keys, and turn inputs stored by those builds carry them. They are validated and dropped
 * so the parsed output never contains them. During the app-first rollout, the mobile HTTP
 * adapter adds null placeholders after validation to satisfy old Workers' required keys.
 */
const LegacyTravelPreferenceEntries = {
  homeStationRef: v.optional(v.nullable(OpaqueIdSchema)),
  maxWalkMinutes: v.optional(LegacyMinutesSchema),
  minimumStayMinutes: v.optional(LegacyMinutesSchema),
};

export const PreferencesSchema = v.pipe(
  v.strictObject({
    areaText: v.nullable(v.pipe(v.string(), v.maxLength(160))),
    budget: v.nullable(v.picklist(['cheap', 'normal', 'any'])),
    ...LegacyTravelPreferenceEntries,
  }),
  v.transform(({ areaText, budget }) => ({ areaText, budget })),
);
export type Preferences = v.InferOutput<typeof PreferencesSchema>;

export const LocationSnapshotSchema = v.pipe(
  v.strictObject({
    status: v.picklist(['available', 'denied', 'reduced', 'timeout', 'unavailable']),
    lat: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(-90), v.maxValue(90))),
    lng: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(-180), v.maxValue(180))),
    accuracyMeters: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0))),
    precise: v.boolean(),
    capturedAt: v.nullable(IsoTimestampSchema),
  }),
  v.check((location) => {
    const hasLat = location.lat !== null;
    const hasLng = location.lng !== null;
    const coordinates = hasLat && hasLng;
    const noCoordinates = !hasLat && !hasLng;
    const hasCapture = location.capturedAt !== null;
    if (!coordinates && !noCoordinates) return false;
    if (location.status === 'available') {
      return coordinates && hasCapture;
    }
    if (location.status === 'reduced') {
      return coordinates && hasCapture && !location.precise;
    }
    return noCoordinates && !location.precise && !hasCapture;
  }, 'location status, coordinates, precision, and capture are inconsistent'),
);
export type LocationSnapshot = v.InferOutput<typeof LocationSnapshotSchema>;

export const SearchModeSchema = v.picklist(['search', 'recover']);

const CandidateOrderSchema = v.pipe(
  v.array(OpaqueIdSchema),
  v.maxLength(3),
  v.check(
    (candidateIds) => new Set(candidateIds).size === candidateIds.length,
    'candidate display order must be unique',
  ),
);

/** HTTP input; Worker must project location and credentials before model input. */
const SearchTurnFields = {
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  turnId: v.nullable(OpaqueIdSchema),
  revision: RevisionSchema,
  text: Text(500),
  clientNow: IsoTimestampSchema,
  location: LocationSnapshotSchema,
  prefs: PreferencesSchema,
  /** Optional for clients that do not yet send the displayed-card context. */
  cardSetId: v.optional(v.nullable(OpaqueIdSchema)),
  promotedCandidateId: v.optional(v.nullable(OpaqueIdSchema)),
  selectedCandidateId: v.optional(v.nullable(OpaqueIdSchema)),
  candidateOrder: v.optional(CandidateOrderSchema),
  /**
   * Sent by app builds from before saved-place consultation was removed (#54). It is validated
   * for those clients and turn inputs they stored, and the Worker does not read it. The mobile
   * HTTP adapter sends an empty array during the app-first rollout for old Workers.
   */
  savedPlaceRefs: v.optional(v.pipe(v.array(OpaqueIdSchema), v.maxLength(50))),
  excludeCandidateIds: v.pipe(v.array(OpaqueIdSchema), v.maxLength(50)),
  mode: SearchModeSchema,
  idempotencyKey: OpaqueIdSchema,
};

export const SearchRequestSchema = v.strictObject({
  ...SearchTurnFields,
  threadId: OpaqueIdSchema,
});
export type SearchRequest = v.InferOutput<typeof SearchRequestSchema>;

/** The thread path supplies ownership; the body therefore carries no duplicate thread ID. */
export const ThreadTurnRequestSchema = v.strictObject(SearchTurnFields);
export type ThreadTurnRequest = v.InferOutput<typeof ThreadTurnRequestSchema>;

export const CreateThreadRequestSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  idempotencyKey: OpaqueIdSchema,
});
export type CreateThreadRequest = v.InferOutput<typeof CreateThreadRequestSchema>;

export const CreateThreadResponseSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  threadId: OpaqueIdSchema,
  revision: RevisionSchema,
  state: v.literal('active'),
});
export type CreateThreadResponse = v.InferOutput<typeof CreateThreadResponseSchema>;

export const EventNameSchema = v.picklist([
  'search_submitted',
  'search_responded',
  'search_failed',
  'turn_started',
  'turn_completed',
  'tool_called',
  'tool_result',
  'card_decided',
  'maps_opened',
  'skip_tapped',
  'recover_started',
  'save_tapped',
  'share_opened',
  'share_cancelled',
  'error_shown',
]);

/** Event payload deliberately has named fields; raw query, secrets and provider records have no slot. */
export const EventPayloadSchema = v.strictObject({
  eventId: OpaqueIdSchema,
  name: EventNameSchema,
  occurredAt: IsoTimestampSchema,
  turnId: v.optional(OpaqueIdSchema),
  revision: v.optional(RevisionSchema),
  candidateId: v.optional(OpaqueIdSchema),
  responseId: v.optional(OpaqueIdSchema),
  durationMs: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  status: v.optional(v.picklist(['ok', 'partial', 'error', 'cancelled'])),
  code: v.optional(v.pipe(v.string(), v.maxLength(80))),
});
export type EventPayload = v.InferOutput<typeof EventPayloadSchema>;

export const EventsRequestSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  threadId: OpaqueIdSchema,
  event: EventPayloadSchema,
});
export type EventsRequest = v.InferOutput<typeof EventsRequestSchema>;
