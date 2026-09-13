import * as v from 'valibot';
import {
  type HarnessContext,
  IsoTimestampSchema,
  type Issue,
  type RegistryScope,
  type SavedPlaceRef,
  type ToolExecutionContext,
} from '@ima/core';
import { normalizeGoogleIdentity } from '../../providers/places/identity';
import { parseGooglePlaceWireField } from '../../providers/places/wire';
import { providerIdFrom } from '../../providers/places-details/adapter-normalization';
import {
  GooglePlaceDetailsError,
  type GooglePlaceDetailsField,
  type GooglePlaceDetailsResponse,
  type GooglePlaceDetailsTransport,
} from '../../providers/places-details/types';
import { providerIssue } from '../../providers/places-details/adapter-result';
import {
  googleFieldsFor,
  type SavedReferenceCandidateRegistry,
  type SavedReferenceDetailsHandoff,
  type SavedReferenceHandoffBinding,
  type SavedReferenceHandoffTakeInput,
  type SavedReferenceProviderRefreshRequest,
  type SavedReferenceProviderRefresher,
} from '../../providers/places-details/handoff';
import type { SavedPlaceReferenceResolver } from '../../tools/types';

type HandoffEntry = {
  readonly savedPlaceRef: SavedPlaceRef;
  readonly scope: RegistryScope;
  readonly turnId: string;
  readonly revision: number;
  readonly provider: string;
  readonly fields: readonly GooglePlaceDetailsField[];
  readonly response: GooglePlaceDetailsResponse;
  readonly observedAt: string;
  readonly expiresAt: string;
  candidateId?: string;
};

const keyFor = (input: {
  readonly savedPlaceRef: string;
  readonly scope: RegistryScope;
  readonly turnId: string;
  readonly revision: number;
}): string =>
  JSON.stringify([
    input.scope.ownerScopeRef,
    input.scope.threadId,
    input.turnId,
    input.revision,
    input.savedPlaceRef,
  ]);

const fieldsKey = (fields: readonly GooglePlaceDetailsField[]): string =>
  [...fields].sort().join('\u0000');

const parsedTime = (value: string): number | undefined => {
  if (!v.safeParse(IsoTimestampSchema, value).success) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
};

const fieldsMatch = (
  actual: readonly GooglePlaceDetailsField[],
  expected: readonly GooglePlaceDetailsField[],
): boolean =>
  actual.length === expected.length &&
  new Set(actual).size === expected.length &&
  expected.every((field) => actual.includes(field));

/** Holds one provider response only for the current turn and consumes it once. */
export const createSavedReferenceDetailsHandoff = (
  now: () => string,
): SavedReferenceDetailsHandoff => {
  const entries = new Map<string, HandoffEntry>();

  const expiryState = (entry: HandoffEntry, currentOverride?: string): 'expired' | undefined => {
    let current: string;
    if (currentOverride !== undefined) {
      current = currentOverride;
    } else {
      try {
        current = now();
      } catch {
        return 'expired';
      }
    }
    const currentMs = parsedTime(current);
    const expiryMs = parsedTime(entry.expiresAt);
    return currentMs === undefined || expiryMs === undefined || currentMs >= expiryMs
      ? 'expired'
      : undefined;
  };

  const entryForCandidate = (input: {
    readonly candidateId: string;
    readonly scope: RegistryScope;
    readonly turnId: string;
    readonly revision: number;
  }): [string, HandoffEntry] | undefined => {
    for (const [key, entry] of entries) {
      if (
        entry.candidateId === input.candidateId &&
        entry.scope.ownerScopeRef === input.scope.ownerScopeRef &&
        entry.scope.threadId === input.scope.threadId &&
        entry.turnId === input.turnId &&
        entry.revision === input.revision
      ) {
        return [key, entry];
      }
    }
    return undefined;
  };

  const entryForBinding = (
    binding: SavedReferenceHandoffBinding,
    candidate?: {
      readonly ownerScopeRef: string;
      readonly threadId: string;
      readonly provider: string;
      readonly recordRef: string;
    },
  ): [string, HandoffEntry] | undefined => {
    for (const [key, entry] of entries) {
      if (
        entry.savedPlaceRef === binding.savedPlaceRef &&
        entry.scope.ownerScopeRef === binding.scope.ownerScopeRef &&
        entry.scope.threadId === binding.scope.threadId &&
        entry.turnId === binding.turnId &&
        entry.revision === binding.revision &&
        (candidate === undefined ||
          (candidate.ownerScopeRef === binding.scope.ownerScopeRef &&
            candidate.threadId === binding.scope.threadId &&
            entry.provider === candidate.provider &&
            entry.response.placeId === candidate.recordRef))
      ) {
        return [key, entry];
      }
    }
    return undefined;
  };

  return {
    stage(input) {
      if (
        parsedTime(input.expiresAt) === undefined ||
        parsedTime(input.observedAt) === undefined ||
        input.response.placeId.length === 0 ||
        !fieldsMatch(input.response.fields, input.fields)
      ) {
        throw new Error('SAVED_REFERENCE_HANDOFF_INVALID');
      }
      const key = keyFor(input);
      const existing = entries.get(key);
      if (existing !== undefined && expiryState(existing) === undefined) {
        throw new Error('SAVED_REFERENCE_HANDOFF_DUPLICATE');
      }
      entries.set(key, { ...input, fields: [...input.fields] });
    },
    canBindCandidate({ binding, candidate }) {
      const found = entryForBinding(binding, candidate);
      return (
        found !== undefined &&
        found[1].candidateId === undefined &&
        expiryState(found[1]) === undefined
      );
    },
    bindCandidate({ binding, candidate }) {
      const found = entryForBinding(binding, candidate);
      if (found === undefined || found[1].candidateId !== undefined) return false;
      if (expiryState(found[1]) !== undefined) return false;
      found[1].candidateId = candidate.candidateId;
      return true;
    },
    takeForCandidate(input: SavedReferenceHandoffTakeInput) {
      const found = entryForCandidate(input);
      if (found === undefined) return undefined;
      const [key, entry] = found;
      entries.delete(key);
      if (expiryState(entry, input.now) !== undefined) return { status: 'expired' as const };
      if (fieldsKey(entry.fields) !== fieldsKey(input.fields)) {
        return { status: 'invalid' as const };
      }
      return {
        status: 'ready' as const,
        response: { ...entry.response, fields: [...entry.fields] },
        observedAt: entry.observedAt,
      };
    },
    coverageForCandidate(input) {
      const found = entryForCandidate(input);
      if (found === undefined) return undefined;
      const [, entry] = found;
      if (expiryState(entry) !== undefined) {
        return 'expired' as const;
      }
      if (!fieldsMatch(entry.fields, input.fields)) return undefined;
      return 'covered' as const;
    },
    discardForReference(input) {
      entries.delete(keyFor(input));
    },
    discardForCandidate(input) {
      const found = entryForCandidate(input);
      if (found !== undefined) entries.delete(found[0]);
    },
    clear() {
      entries.clear();
    },
  };
};

const issue = (code: Issue['code'], message: string, retryable = false): Issue => ({
  code,
  path: 'savedPlaceRef',
  retryable,
  retryAfterMs: null,
  message,
  missingFields: [],
});

const providerFailure = (error: unknown): Issue =>
  error instanceof GooglePlaceDetailsError
    ? providerIssue(error, 'savedPlaceRef')
    : issue('UPSTREAM_UNAVAILABLE', 'saved place provider is unavailable', true);

const fetchFieldsFor = (
  fields: readonly GooglePlaceDetailsField[],
): readonly GooglePlaceDetailsField[] => [
  'identity',
  ...fields.filter((field) => field !== 'identity'),
];

export type SavedReferenceGoogleProviderOptions = {
  readonly transport: GooglePlaceDetailsTransport;
  readonly handoff: SavedReferenceDetailsHandoff;
  readonly areaLabelFor: (context: HarnessContext) => string | undefined;
  readonly now: () => string;
  readonly sessionExpiresAt: () => string | undefined;
  readonly signalFor?: (execution: ToolExecutionContext) => AbortSignal | undefined;
  readonly requestSignal?: AbortSignal;
};

/** Fetches and normalizes one saved reference; the raw response remains in the handoff only. */
export const createSavedReferenceGoogleProvider = (
  options: SavedReferenceGoogleProviderOptions,
): SavedReferenceProviderRefresher => ({
  async refresh(input: SavedReferenceProviderRefreshRequest): Promise<unknown> {
    if (
      input.savedPlaceRef !== input.reference.savedPlaceRef ||
      input.reference.ownerScopeRef !== input.scope.ownerScopeRef ||
      input.scope.ownerScopeRef !== input.context.ownerScopeRef ||
      input.scope.threadId !== input.context.threadId ||
      input.execution.operation !== 'get_place_details' ||
      input.execution.threadId !== input.context.threadId ||
      input.execution.turnId !== input.context.turnId ||
      input.execution.revision !== input.context.revision ||
      input.fields.length === 0 ||
      new Set(input.fields).size !== input.fields.length
    ) {
      return {
        status: 'error',
        error: issue('INVALID_ARGUMENT', 'saved reference request is invalid'),
      };
    }
    if (input.reference.provider !== 'google_places') {
      return {
        status: 'error',
        error: issue('UNSUPPORTED_SCOPE', 'saved place provider is unsupported'),
      };
    }
    if (input.cancellation.isCancelled()) {
      return { status: 'error', error: issue('CANCELLED', 'saved reference read was cancelled') };
    }
    let areaLabel: string | undefined;
    try {
      areaLabel = options.areaLabelFor(input.context);
    } catch {
      areaLabel = undefined;
    }
    if (areaLabel === undefined || areaLabel.length === 0) {
      return {
        status: 'error',
        error: issue('MISSING_CONTEXT', 'saved place area is unavailable'),
      };
    }
    const fields = googleFieldsFor(input.fields);
    const fetchFields = fetchFieldsFor(fields);
    let response: GooglePlaceDetailsResponse;
    try {
      response = await options.transport.read(
        { placeId: input.reference.recordRef, fields: [...fetchFields] },
        input.signal ?? options.signalFor?.(input.execution) ?? options.requestSignal,
      );
    } catch (error: unknown) {
      return { status: 'error', error: providerFailure(error) };
    }
    if (input.cancellation.isCancelled()) {
      return { status: 'error', error: issue('CANCELLED', 'saved reference read was cancelled') };
    }
    if (
      response.placeId !== input.reference.recordRef ||
      providerIdFrom(response.body) !== input.reference.recordRef ||
      !fieldsMatch(response.fields, fetchFields)
    ) {
      return {
        status: 'error',
        error: issue('SCHEMA_MISMATCH', 'saved place provider response is invalid'),
      };
    }
    let identityWire: ReturnType<typeof parseGooglePlaceWireField>;
    try {
      identityWire = parseGooglePlaceWireField('identity', response.body);
    } catch {
      return {
        status: 'error',
        error: issue('SCHEMA_MISMATCH', 'saved place identity is invalid'),
      };
    }
    const identity = normalizeGoogleIdentity(identityWire, areaLabel).value;
    if (identity.status === 'unknown') {
      return {
        status: 'error',
        error: issue('UNKNOWN_CANDIDATE', 'saved place identity is unknown'),
      };
    }
    if (identity.status === 'error') {
      return { status: 'error', error: issue(identity.code, 'saved place identity is invalid') };
    }
    let expiresAt: string | undefined;
    try {
      expiresAt = options.sessionExpiresAt();
    } catch {
      expiresAt = undefined;
    }
    if (expiresAt === undefined || parsedTime(expiresAt) === undefined) {
      return {
        status: 'error',
        error: issue('MISSING_CONTEXT', 'saved reference deadline is unavailable'),
      };
    }
    let now: string;
    try {
      now = options.now();
    } catch {
      return {
        status: 'error',
        error: issue('MISSING_CONTEXT', 'saved reference clock is unavailable'),
      };
    }
    const nowMs = parsedTime(now);
    const expiryMs = parsedTime(expiresAt);
    if (nowMs === undefined || expiryMs === undefined || nowMs >= expiryMs) {
      return { status: 'error', error: issue('STALE_TURN', 'saved reference session has expired') };
    }
    const observedAt = now;
    try {
      options.handoff.stage({
        savedPlaceRef: input.savedPlaceRef,
        scope: input.scope,
        turnId: input.execution.turnId,
        revision: input.execution.revision,
        provider: input.reference.provider,
        fields,
        response: { ...response, fields: [...fields] },
        observedAt,
        expiresAt,
      });
    } catch {
      return {
        status: 'error',
        error: issue('MISSING_CONTEXT', 'saved reference handoff is unavailable'),
      };
    }
    return {
      status: 'ok',
      candidate: {
        ownerScopeRef: input.scope.ownerScopeRef,
        threadId: input.scope.threadId,
        provider: input.reference.provider,
        recordRef: input.reference.recordRef,
        displayName: identity.value.name,
        status: identity.value.businessStatus,
      },
    };
  },
});

export const createHandoffCandidateRegistry = (
  registry: SavedReferenceCandidateRegistry,
  handoff: SavedReferenceDetailsHandoff,
): SavedReferenceCandidateRegistry => ({
  listCandidates: (scope) => registry.listCandidates(scope),
  registerCandidate: (input, binding) => {
    if (binding === undefined || !handoff.canBindCandidate({ binding, candidate: input })) {
      throw new Error('SAVED_REFERENCE_HANDOFF_BINDING');
    }
    const candidate = registry.registerCandidate(input);
    if (!handoff.bindCandidate({ binding, candidate })) {
      throw new Error('SAVED_REFERENCE_HANDOFF_BINDING');
    }
    return candidate;
  },
});

const isResultError = (value: unknown): boolean =>
  typeof value !== 'object' || value === null || !('status' in value) || value.status !== 'ok';

/** Drops staged raw data on every resolver failure; success leaves it for Details to consume once. */
export const createHandoffAwareSavedResolver =
  (
    resolver: SavedPlaceReferenceResolver,
    handoff: SavedReferenceDetailsHandoff,
  ): SavedPlaceReferenceResolver =>
  async (request) => {
    const identity = {
      savedPlaceRef: request.savedPlaceRef,
      scope: { ownerScopeRef: request.context.ownerScopeRef, threadId: request.context.threadId },
      turnId: request.execution.turnId,
      revision: request.execution.revision,
    };
    try {
      const result = await resolver(request);
      if (isResultError(result)) handoff.discardForReference(identity);
      return result;
    } catch (error: unknown) {
      handoff.discardForReference(identity);
      throw error;
    }
  };
