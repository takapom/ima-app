import * as v from 'valibot';
import {
  ContactInfoSchema,
  ObservationSchema,
  OpeningHoursSchema,
  PhotoInfoSchema,
  PlaceIdentitySchema,
  PriceInfoSchema,
  type FieldResult,
  type Issue,
  type ObservationContext,
  type ReadonlyStoredObservation,
  type RegistryJsonValue,
  type SourceRef,
} from '@ima/core';
import {
  normalizeGoogleContact,
  normalizeGooglePhotos,
  normalizeGooglePrice,
  type GoogleNormalizedValue,
} from '../places/values';
import { normalizeGoogleIdentity } from '../places/identity';
import { normalizeGoogleOpeningHours } from '../places/hours';
import { normalizeGoogleSourceMetadata } from '../places/source';
import {
  GooglePlacesWireError,
  parseGooglePlaceWireField,
  type GooglePlaceWire,
} from '../places/wire';
import { fieldError, issue } from './adapter-support';
import type { GooglePlaceDetailsField } from './types';
import type { PlacesDetailsAdapterOptions } from './adapter-types';

export const sourceInfo = (
  body: unknown,
  recordRef: string,
): { readonly ok: true; readonly sources: readonly SourceRef[] } | { readonly ok: false } => {
  let source: GooglePlaceWire;
  try {
    source = parseGooglePlaceWireField('source', body);
  } catch {
    return { ok: false };
  }
  const normalized = normalizeGoogleSourceMetadata(source, recordRef);
  return normalized.ok ? normalized : { ok: false };
};

export const providerIdFrom = (body: unknown): string | undefined => {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(body, 'id');
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
};

const storedField = <T extends RegistryJsonValue>(
  stored: ReadonlyStoredObservation,
  field: GooglePlaceDetailsField,
  schema: v.GenericSchema<T, T>,
): FieldResult<T> => {
  if (stored.field !== field) {
    return fieldError(issue('SCHEMA_MISMATCH', field, 'stored observation does not match field'));
  }
  const parsed = v.safeParse(ObservationSchema(schema), stored);
  return parsed.success
    ? { status: 'known', observations: [parsed.output] }
    : fieldError(issue('SCHEMA_MISMATCH', field, 'stored observation is invalid'));
};

export const storedFieldFor = (
  stored: ReadonlyStoredObservation,
  field: GooglePlaceDetailsField,
): unknown => {
  switch (field) {
    case 'identity':
      return storedField(stored, field, PlaceIdentitySchema);
    case 'opening_hours':
      return storedField(stored, field, OpeningHoursSchema);
    case 'price':
      return storedField(stored, field, PriceInfoSchema);
    case 'photos':
      return storedField(stored, field, PhotoInfoSchema);
    case 'contact':
      return storedField(stored, field, ContactInfoSchema);
  }
};

const normalizedIssue = <T>(
  field: GooglePlaceDetailsField,
  normalized: Extract<GoogleNormalizedValue<T>, { status: 'error' }>,
): Issue => issue(normalized.code, field, normalized.reason);

const registerKnown = <T extends RegistryJsonValue>(
  normalized: GoogleNormalizedValue<T>,
  field: GooglePlaceDetailsField,
  schema: v.GenericSchema<T, T>,
  candidateId: string,
  context: ObservationContext,
  sources: readonly SourceRef[],
  now: string,
  options: PlacesDetailsAdapterOptions,
): FieldResult<T> => {
  if (normalized.status === 'unknown') return { status: 'unknown', reason: normalized.reason };
  if (normalized.status === 'error') return fieldError(normalizedIssue(field, normalized));
  const policy = options.observationPolicy;
  if (policy === undefined) {
    return fieldError(issue('MISSING_CONTEXT', field, 'observation policy is unavailable'));
  }
  const observation = {
    scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
    candidateId,
    field,
    value: normalized.value,
    basis: 'provider_reported' as const,
    sourceUpdatedAt: null,
    context,
    sources,
  };
  let policyResult:
    ReturnType<NonNullable<PlacesDetailsAdapterOptions['observationPolicy']>> | undefined;
  try {
    policyResult = policy({ now, observation });
  } catch {
    return fieldError(issue('MISSING_CONTEXT', field, 'observation policy is unavailable'));
  }
  if (policyResult === undefined) {
    return fieldError(issue('MISSING_CONTEXT', field, 'observation policy withheld this value'));
  }
  let stored: ReadonlyStoredObservation;
  try {
    stored = options.registry.registerObservation({ ...observation, ...policyResult });
    if (
      !options.registry.restoreObservationReuse(
        { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
        candidateId,
        field,
        [stored.observationId],
      )
    ) {
      return fieldError(issue('MISSING_CONTEXT', field, 'observation reuse could not be restored'));
    }
  } catch {
    return fieldError(issue('MISSING_CONTEXT', field, 'observation registration is unavailable'));
  }
  return storedField(stored, field, schema);
};

const parseField = (
  field: GooglePlaceDetailsField,
  body: unknown,
): GooglePlaceWire | { readonly error: Issue } => {
  try {
    return parseGooglePlaceWireField(field, body);
  } catch (error: unknown) {
    return error instanceof GooglePlacesWireError
      ? { error: issue('SCHEMA_MISMATCH', field, 'provider field is invalid') }
      : {
          error: issue(
            'UPSTREAM_UNAVAILABLE',
            field,
            'place details provider is unavailable',
            true,
          ),
        };
  }
};

/** Normalizes and registers one provider field after its old reuse has been blocked. */
export const normalizeAndRegisterField = (
  field: GooglePlaceDetailsField,
  body: unknown,
  areaLabel: string,
  evaluatedAt: string,
  candidateId: string,
  context: ObservationContext,
  sources: readonly SourceRef[],
  now: string,
  options: PlacesDetailsAdapterOptions,
): unknown => {
  const parsed = parseField(field, body);
  if ('error' in parsed) return fieldError(parsed.error);
  switch (field) {
    case 'identity':
      return registerKnown(
        normalizeGoogleIdentity(parsed, areaLabel).value,
        field,
        PlaceIdentitySchema,
        candidateId,
        context,
        sources,
        now,
        options,
      );
    case 'opening_hours':
      return registerKnown(
        normalizeGoogleOpeningHours(parsed, evaluatedAt),
        field,
        OpeningHoursSchema,
        candidateId,
        context,
        sources,
        now,
        options,
      );
    case 'price':
      return registerKnown(
        normalizeGooglePrice(parsed),
        field,
        PriceInfoSchema,
        candidateId,
        context,
        sources,
        now,
        options,
      );
    case 'photos':
      return registerKnown(
        normalizeGooglePhotos(parsed),
        field,
        PhotoInfoSchema,
        candidateId,
        context,
        sources,
        now,
        options,
      );
    case 'contact':
      return registerKnown(
        normalizeGoogleContact(parsed),
        field,
        ContactInfoSchema,
        candidateId,
        context,
        sources,
        now,
        options,
      );
  }
};
