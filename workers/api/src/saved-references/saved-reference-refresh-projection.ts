import * as v from 'valibot';
import {
  CandidateIdSchema,
  EvidenceRefSchema,
  OpaqueIdSchema,
  SavedReferenceResponseSchema,
  type EvidenceRef,
  type RetentionMetadata,
  type SavedReferenceResponse,
  parseRetentionMetadata,
} from '@ima/contracts';
import type { SourceRef } from '@ima/core';
import { HttpBoundaryError, type BoundaryFailure } from '../http/errors';
import type { HandlerContext } from '../http/handler';
import type {
  GooglePlaceDetailsField,
  GooglePlaceDetailsResponse,
} from '../providers/places-details/types';
import { providerIdFrom, sourceInfo } from '../providers/places-details/adapter-normalization';
import { responseMatches } from '../providers/places-details/adapter-support';
import { normalizeGoogleIdentity } from '../providers/places/identity';
import { parseGooglePlaceWireField } from '../providers/places/wire';
import {
  boundProductionRetention,
  sessionExpiryAt,
} from '../runtime/composition/runtime-production-support';
import type {
  SavedReferenceRefreshIdInput,
  SavedReferenceRefreshProjectionDependencies,
  SavedReferenceRefreshRetentionInput,
} from './saved-reference-refresh-types';

const IDENTITY_FIELDS: readonly GooglePlaceDetailsField[] = ['identity'];

const boundary = (failure: BoundaryFailure): never => {
  throw new HttpBoundaryError(failure);
};

const internal = (): never => boundary({ status: 500, code: 'INTERNAL' });
const unavailable = (): never => boundary({ status: 502, code: 'PROVIDER_UNAVAILABLE' });
const schemaMismatch = (): never => boundary({ status: 409, code: 'SCHEMA_MISMATCH' });
const expired = (): never => boundary({ status: 410, code: 'EXPIRED' });

const dateIsAtOrAfter = (now: string, deadline: string | null): boolean =>
  deadline !== null && Date.parse(now) >= Date.parse(deadline);

/** Display policy is evaluated here; storage and model-input permissions are independent. */
const usableRetention = (
  value: unknown,
  now: string,
  fixedSessionExpiresAt: string,
): RetentionMetadata => {
  const parsedRetention = parseRetentionMetadata(value);
  if (parsedRetention === null) return schemaMismatch();
  const retention = boundProductionRetention(parsedRetention, fixedSessionExpiresAt);
  if (retention.displayPolicyStatus === 'expired') return expired();
  if (retention.displayPolicyStatus !== 'available') {
    return unavailable();
  }
  if (
    dateIsAtOrAfter(now, retention.sessionExpiresAt) ||
    dateIsAtOrAfter(now, retention.freshUntil) ||
    dateIsAtOrAfter(now, retention.displayUntil) ||
    dateIsAtOrAfter(now, retention.retentionUntil) ||
    dateIsAtOrAfter(now, retention.deletionScheduledAt)
  ) {
    return expired();
  }
  return retention;
};

const attributionFor = (
  source: SourceRef,
  retention: RetentionMetadata,
): EvidenceRef['attribution'] =>
  source.attribution === null
    ? retention.attribution
    : { label: source.attribution, sourceLink: source.publicUrl };

const evidenceFor = (
  sources: readonly SourceRef[],
  retention: RetentionMetadata,
  input: SavedReferenceRefreshIdInput,
  evidenceIdFactory: NonNullable<SavedReferenceRefreshProjectionDependencies['evidenceIdFactory']>,
): EvidenceRef[] => {
  const evidence = sources.map((source, index) => {
    const evidenceId = evidenceIdFactory({ ...input, index });
    if (!v.safeParse(OpaqueIdSchema, evidenceId).success) return internal();
    const attribution = attributionFor(source, retention);
    const item = {
      evidenceId,
      attribution,
      retention: { ...retention, attribution },
    } satisfies EvidenceRef;
    const parsed = v.safeParse(EvidenceRefSchema, item);
    if (!parsed.success) schemaMismatch();
    return item;
  });
  if (
    evidence.length === 0 ||
    new Set(evidence.map((item) => item.evidenceId)).size !== evidence.length
  ) {
    schemaMismatch();
  }
  return evidence;
};

export const publicResponseFor = (
  response: GooglePlaceDetailsResponse,
  reference: { readonly provider: string; readonly recordRef: string },
  context: HandlerContext,
  dependencies: SavedReferenceRefreshProjectionDependencies,
  savedPlaceRef: string,
  now: string,
  policyNow: string,
): SavedReferenceResponse => {
  if (!responseMatches(response, reference.recordRef, IDENTITY_FIELDS)) schemaMismatch();
  if (providerIdFrom(response.body) !== reference.recordRef) schemaMismatch();

  const sources = sourceInfo(response.body, reference.recordRef);
  if (sources.ok !== true) return schemaMismatch();
  let place: ReturnType<typeof parseGooglePlaceWireField> | undefined;
  try {
    place = parseGooglePlaceWireField('identity', response.body);
  } catch {
    return schemaMismatch();
  }
  if (place === undefined) return schemaMismatch();
  const address = place.formattedAddress;
  if (address === undefined || address.trim().length === 0 || address.length > 160) {
    return schemaMismatch();
  }
  const normalized = normalizeGoogleIdentity(place, address).value;
  if (normalized.status !== 'known') {
    if (normalized.status === 'error' && normalized.code === 'SOURCE_CONFLICT') {
      throw new HttpBoundaryError({ status: 502, code: 'SOURCE_CONFLICT' });
    }
    return schemaMismatch();
  }

  const retentionInput: SavedReferenceRefreshRetentionInput = {
    ownerScopeRef: context.ownerScopeRef,
    savedPlaceRef,
    provider: reference.provider,
    recordRef: reference.recordRef,
    now: policyNow,
    sources: sources.sources,
  };
  let retentionValue: RetentionMetadata | undefined;
  try {
    retentionValue = dependencies.retentionFor(retentionInput);
  } catch {
    return unavailable();
  }
  if (retentionValue === undefined) return unavailable();
  const retention = usableRetention(retentionValue, now, sessionExpiryAt(policyNow));
  const idInput: SavedReferenceRefreshIdInput = {
    requestId: context.requestId,
    savedPlaceRef,
    recordRef: reference.recordRef,
  };
  const candidateId =
    dependencies.candidateIdFactory?.(idInput) ?? `saved-refresh-${crypto.randomUUID()}`;
  if (!v.safeParse(CandidateIdSchema, candidateId).success) return internal();
  const evidence = evidenceFor(
    sources.sources,
    retention,
    idInput,
    dependencies.evidenceIdFactory ??
      ((input) => `saved-refresh-evidence-${input.index}-${crypto.randomUUID()}`),
  );
  const data = {
    items: [
      {
        candidateId,
        fields: {
          identity: {
            status: 'known' as const,
            value: normalized.value,
            evidence,
          },
        },
      },
    ],
  };
  const candidate = {
    candidateId,
    evidenceIds: evidence.map((item) => item.evidenceId),
  };
  const parsed = v.safeParse(SavedReferenceResponseSchema, {
    schemaVersion: 'v1',
    requestId: context.requestId,
    savedPlaceRef,
    candidate,
    data,
  });
  if (!parsed.success) internal();
  return {
    schemaVersion: 'v1',
    requestId: context.requestId,
    savedPlaceRef,
    candidate,
    data,
  } satisfies SavedReferenceResponse;
};

/** Re-checks the generated DTO after ID factories and before the response is sent. */
export const assertPublicResponseUsableAt = (
  response: SavedReferenceResponse,
  now: string,
  policyNow: string,
): void => {
  const identity = response.data.items[0]?.fields.identity;
  if (identity?.status !== 'known') return schemaMismatch();
  const fixedSessionExpiresAt = sessionExpiryAt(policyNow);
  for (const evidence of identity.evidence) {
    usableRetention(evidence.retention, now, fixedSessionExpiresAt);
  }
};
