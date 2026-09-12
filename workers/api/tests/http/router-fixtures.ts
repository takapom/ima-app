import * as v from 'valibot';
import {
  CreateThreadResponseSchema,
  EventsRequestSchema,
  LifecycleCommandSchema,
  LifecycleResponseSchema,
  PhotoResponseDescriptorSchema,
  PrefsReadResponseSchema,
  PrefsWriteRequestSchema,
  PrefsWriteResponseSchema,
  SavedReferenceCreateResponseSchema,
  SavedReferenceListResponseSchema,
  SavedReferenceResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  ThreadReadResponseSchema,
  ThreadTurnRequestSchema,
} from '@ima/contracts';
import type {
  ApplicationHandler,
  ApplicationOperation,
  ApplicationResult,
  EventsSink,
  HandlerContext,
  PhotoBodyHandler,
  RateLimiter,
  RateLimitResult,
} from '../../src/http/handler';
import { type HttpRouterConfig, type ResourceKind } from '../../src/http/router';
import { HttpBoundaryError, type BoundaryFailure } from '../../src/http/errors';

export const requestId = 'request-1';
export const appToken = 'test-app-token';
export const ownerCredential = 'A'.repeat(43);
export const now = '2026-09-09T12:00:00Z';
export const threadId = 'thread-1';
export const candidateId = 'candidate-1';
export const savedPlaceRef = 'saved-1';
export const photoToken = 'photo-token-1';

const parse = <Schema extends v.GenericSchema>(
  schema: Schema,
  value: unknown,
): v.InferOutput<Schema> => v.parse(schema, value);

const retention = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T05:00:00+09:00',
  freshUntil: now,
  displayUntil: '2026-09-09T13:00:00Z',
  retentionUntil: '2026-09-10T05:00:00+09:00',
  deletionScheduledAt: '2026-09-10T05:00:00+09:00',
  attribution: { label: 'Example source', sourceLink: 'https://example.com/source' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const evidence = {
  evidenceId: 'evidence-1',
  attribution: { label: 'Example source', sourceLink: 'https://example.com/source' },
  retention,
};

const message = {
  text: '徒歩で行きやすい候補です',
  evidenceIds: [evidence.evidenceId],
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

const response = {
  schemaVersion: 'v1',
  threadId,
  turnId: 'turn-1',
  responseId: 'response-1',
  revision: 1,
  kind: 'message',
  presentation: 'keep',
  cardSetId: null,
  message: [message],
};

export const searchInput = parse(SearchRequestSchema, {
  schemaVersion: 'v1',
  requestId,
  threadId,
  turnId: null,
  revision: 1,
  text: '静かで甘いもの',
  clientNow: now,
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
  idempotencyKey: 'idempotency-1',
});

export const turnInput = parse(ThreadTurnRequestSchema, {
  schemaVersion: 'v1',
  requestId,
  turnId: null,
  revision: 1,
  text: 'もう少し駅に近い場所',
  clientNow: now,
  location: searchInput.location,
  prefs: searchInput.prefs,
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: 'idempotency-2',
});

export const eventsInput = parse(EventsRequestSchema, {
  schemaVersion: 'v1',
  requestId,
  threadId,
  event: {
    eventId: 'event-1',
    name: 'turn_completed',
    occurredAt: now,
    durationMs: 100,
    status: 'ok',
  },
});

export const lifecycleInput = parse(LifecycleCommandSchema, {
  schemaVersion: 'v1',
  requestId,
  turnId: 'turn-1',
  revision: 1,
  idempotencyKey: 'idempotency-lifecycle',
});

export const createResponse = parse(CreateThreadResponseSchema, {
  schemaVersion: 'v1',
  requestId,
  threadId,
  revision: 1,
  state: 'active',
});

export const searchResponse = parse(SearchResponseSchema, {
  requestId,
  response,
  warnings: [],
});

export const threadReadResponse = parse(ThreadReadResponseSchema, {
  schemaVersion: 'v1',
  requestId,
  threadId,
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
      restoreMode: 'reference_only',
    },
  ],
});

export const lifecycleResponse = parse(LifecycleResponseSchema, {
  schemaVersion: 'v1',
  requestId,
  threadId,
  turnId: 'turn-1',
  revision: 2,
  state: 'active',
});

export const savedReferenceResponse = parse(SavedReferenceResponseSchema, {
  schemaVersion: 'v1',
  requestId,
  savedPlaceRef,
  candidate: { candidateId, evidenceIds: [evidence.evidenceId] },
  data: { items: [{ candidateId, fields: { identity } }] },
});

export const savedReferenceCreateResponse = parse(SavedReferenceCreateResponseSchema, {
  schemaVersion: 'v1',
  requestId,
  candidateId,
  savedPlaceRef,
});

export const prefsWriteInput = parse(PrefsWriteRequestSchema, {
  schemaVersion: 'v1',
  requestId,
  expectedRevision: 0,
  prefs: searchInput.prefs,
});

export const prefsReadResponse = parse(PrefsReadResponseSchema, {
  schemaVersion: 'v1',
  requestId,
  revision: 0,
  prefs: null,
});

export const prefsWriteResponse = parse(PrefsWriteResponseSchema, {
  schemaVersion: 'v1',
  requestId,
  revision: 1,
});

export const savedReferenceListResponse = parse(SavedReferenceListResponseSchema, {
  schemaVersion: 'v1',
  requestId,
  savedPlaceRefs: [savedPlaceRef],
});

export const photoDescriptor = parse(PhotoResponseDescriptorSchema, {
  schemaVersion: 'v1',
  requestId,
  token: photoToken,
  contentType: 'image/png',
  expiresAt: '2026-09-10T12:00:00Z',
});

export type Harness = {
  readonly config: HttpRouterConfig;
  readonly calls: {
    application: number;
    photo: number;
    events: number;
    rate: number;
    ownership: ResourceKind[];
    contexts: HandlerContext[];
    operations: ApplicationOperation[];
  };
};

export type HarnessOptions = {
  readonly denyKind?: ResourceKind;
  readonly rate?: RateLimitResult;
  readonly applicationFailure?: BoundaryFailure;
  readonly rawApplicationError?: boolean;
  readonly photoExpiresAt?: string;
  readonly photoRequestId?: string;
  readonly serverNow?: string;
  readonly nowValues?: readonly string[];
  readonly photoDelay?: boolean;
};

const applicationResult = (operation: ApplicationOperation): ApplicationResult => {
  switch (operation.kind) {
    case 'create_thread':
      return { kind: operation.kind, response: createResponse };
    case 'search':
    case 'turn':
      return { kind: operation.kind, response: searchResponse };
    case 'read_thread':
    case 'replay_thread':
      return { kind: operation.kind, response: threadReadResponse };
    case 'lifecycle':
      return { kind: operation.kind, response: lifecycleResponse };
    case 'delete_thread':
      return { kind: operation.kind, response: null };
    case 'saved_reference_refresh':
      return { kind: operation.kind, response: savedReferenceResponse };
    case 'prefs_read':
      return { kind: operation.kind, response: prefsReadResponse };
    case 'prefs_write':
      return { kind: operation.kind, response: prefsWriteResponse };
    case 'saved_reference_list':
      return { kind: operation.kind, response: savedReferenceListResponse };
    case 'saved_reference_create':
      return { kind: operation.kind, response: savedReferenceCreateResponse };
    case 'saved_reference_delete':
      return { kind: operation.kind, response: null };
    case 'place_decide':
      return {
        kind: operation.kind,
        response: {
          schemaVersion: 'v1',
          requestId,
          candidateId,
          savedPlaceRef,
          decidedAt: now,
        },
      };
  }
};

export const makeHarness = (options: HarnessOptions = {}): Harness => {
  const calls: Harness['calls'] = {
    application: 0,
    photo: 0,
    events: 0,
    rate: 0,
    ownership: [],
    contexts: [],
    operations: [],
  };
  const application: ApplicationHandler = {
    handle(operation, context) {
      calls.application += 1;
      calls.contexts.push(context);
      calls.operations.push(operation);
      if (options.rawApplicationError === true) {
        return Promise.reject(new Error('provider secret should not be returned'));
      }
      if (options.applicationFailure !== undefined) {
        return Promise.reject(new HttpBoundaryError(options.applicationFailure));
      }
      return Promise.resolve(applicationResult(operation));
    },
  };
  const photo: PhotoBodyHandler = {
    read(_path, context) {
      calls.photo += 1;
      calls.contexts.push(context);
      const result = {
        descriptor: {
          ...photoDescriptor,
          requestId: options.photoRequestId ?? requestId,
          expiresAt: options.photoExpiresAt ?? photoDescriptor.expiresAt,
        },
        body: new Uint8Array([1, 2, 3]),
      };
      if (options.photoDelay === true) {
        return new Promise((resolve) => {
          queueMicrotask(() => resolve(result));
        });
      }
      return Promise.resolve(result);
    },
  };
  const events: EventsSink = {
    accept(_input, context) {
      calls.events += 1;
      calls.contexts.push(context);
      return Promise.resolve();
    },
  };
  const rateLimiter: RateLimiter = {
    check() {
      calls.rate += 1;
      return Promise.resolve(options.rate ?? { allowed: true, retryAfterSeconds: null });
    },
  };
  let clockRead = 0;
  const serverClock = (): string => {
    const values = options.nowValues;
    if (values !== undefined && values.length > 0) {
      const value = values[Math.min(clockRead, values.length - 1)];
      clockRead += 1;
      if (value !== undefined) return value;
    }
    return options.serverNow ?? now;
  };
  return {
    calls,
    config: {
      auth: { appToken, requestIdFactory: () => 'generated-request' },
      handlers: { application, photo, events, rateLimiter },
      ownership: {
        authorize(input) {
          calls.ownership.push(input.resource.kind);
          return Promise.resolve(
            input.resource.kind === options.denyKind
              ? { allowed: false, failure: { status: 403, code: 'FORBIDDEN' } }
              : { allowed: true },
          );
        },
      },
      now: serverClock,
    },
  };
};

export const authenticatedHeaders = (id = requestId): HeadersInit => ({
  'X-App-Token': appToken,
  'X-Device-Id': 'device-1',
  'X-Ima-Owner-Credential': ownerCredential,
  'X-Ima-Request-Id': id,
  'X-App-Version': '1.0.0',
});

export const makeRequest = (
  path: string,
  init: RequestInit & { readonly json?: unknown } = {},
): Request => {
  const headers = new Headers({ ...authenticatedHeaders(), ...init.headers });
  const body = init.json === undefined ? (init.body ?? null) : JSON.stringify(init.json);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  const { json: _json, body: _body, ...requestInit } = init;
  void _json;
  void _body;
  return new Request(`https://example.test${path}`, { ...requestInit, headers, body });
};
