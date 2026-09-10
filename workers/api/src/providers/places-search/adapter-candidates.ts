import * as v from 'valibot';
import {
  ObservationSchema,
  OpeningHoursSchema,
  PlaceIdentitySchema,
  PriceInfoSchema,
  type CandidateRecord,
  type FieldResult,
  type HarnessContext,
  type Issue,
  type ObservationContext,
  type OpeningHours,
  type PlaceIdentity,
  type PriceInfo,
  type RegistryJsonValue,
  type SearchPlacesOutput,
  type SourceRef,
} from '@ima/core';
import { normalizeGooglePrice, type GoogleNormalizedValue } from '../places/values';
import { normalizeGoogleIdentity } from '../places/identity';
import { googleSourceMetadataIsValid, normalizeGoogleSourceMetadata } from '../places/source';
import {
  GooglePlacesWireError,
  parseGooglePlaceWireField,
  type GooglePlaceWire,
} from '../places/wire';
import type { GoogleTextSearchPage } from './types';
import {
  issue,
  type CandidateBuildResult,
  type PlacesSearchAdapterOptions,
  type SearchField,
  type SearchPlan,
} from './adapter-types';
import type { PlacesSearchObservationInput, PlacesSearchRegistration } from './registration';

const candidateStatus = (value: string | undefined): CandidateRecord['status'] => {
  switch (value) {
    case undefined:
      return 'unknown';
    case 'OPERATIONAL':
      return 'operational';
    case 'CLOSED_TEMPORARILY':
      return 'temporarily_closed';
    case 'CLOSED_PERMANENTLY':
      return 'permanently_closed';
    default:
      return 'unknown';
  }
};

const sourceFor = (place: GooglePlaceWire | undefined, recordRef: string): readonly SourceRef[] => {
  return normalizeGoogleSourceMetadata(place, recordRef).sources;
};

const observationContextFor = (
  context: HarnessContext,
  locationRevision: number,
): ObservationContext => ({
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
  capabilityVersion: context.capabilities.version,
  locationRevision,
  originRef: null,
  homeStationRef: context.preferences.homeStationRef,
  minimumStayMinutes: context.preferences.minimumStayMinutes,
  timeContext: 'now',
});

const fieldError = <T>(error: Issue): FieldResult<T> => ({ status: 'error', error });

const normalizedError = (
  code: 'SCHEMA_MISMATCH' | 'SOURCE_CONFLICT',
  field: SearchField,
  reason: string,
): Issue => issue(code, field, reason);

const registerKnown = <T>(
  normalized: GoogleNormalizedValue<T>,
  field: SearchField,
  schema: v.GenericSchema<T, T>,
  candidateId: string,
  context: ObservationContext,
  sources: readonly SourceRef[],
  registration: PlacesSearchRegistration,
  toRegistryValue: (value: T) => RegistryJsonValue,
): FieldResult<T> => {
  if (normalized.status === 'unknown') {
    return { status: 'unknown', reason: normalized.reason };
  }
  if (normalized.status === 'error') {
    return fieldError(normalizedError(normalized.code, field, normalized.reason));
  }

  let stored;
  try {
    const input: PlacesSearchObservationInput = {
      scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      candidateId,
      field,
      value: toRegistryValue(normalized.value),
      basis: 'provider_reported',
      sourceUpdatedAt: null,
      context,
      sources,
    };
    stored = registration.registerObservation(input);
  } catch {
    return fieldError(issue('MISSING_CONTEXT', field, 'observation registration is unavailable'));
  }
  if (stored === undefined) {
    return fieldError(issue('MISSING_CONTEXT', field, 'retention policy is unavailable'));
  }
  const parsed = v.safeParse(ObservationSchema(schema), stored);
  if (!parsed.success) {
    return fieldError(issue('SCHEMA_MISMATCH', field, 'registered observation is invalid'));
  }
  return { status: 'known', observations: [parsed.output] };
};

const invalidPrice = (): GoogleNormalizedValue<PriceInfo> => ({
  status: 'error',
  code: 'SCHEMA_MISMATCH',
  reason: 'provider price field is invalid',
});

const unknownHours = (): GoogleNormalizedValue<OpeningHours> => ({
  status: 'unknown',
  reason: 'provider opening-hours field is invalid or unavailable',
});

const warningForPlace = (index: number): Issue =>
  issue('SCHEMA_MISMATCH', `places[${index}]`, 'provider place was not usable');

const invalidIdentity = (index: number): Issue =>
  issue('SCHEMA_MISMATCH', `places[${index}].identity`, 'provider identity field is invalid');

type ParsedPlaceFields = {
  readonly identity: GooglePlaceWire;
  readonly price: GooglePlaceWire;
  readonly priceValid: boolean;
  readonly hoursValid: boolean;
  readonly sourceValid: boolean;
  readonly hours?: GooglePlaceWire;
  readonly source?: GooglePlaceWire;
};

const recordOf = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
};

const parsePlaceFields = (raw: unknown, index: number): ParsedPlaceFields | { error: Issue } => {
  let identity: GooglePlaceWire;
  let price: GooglePlaceWire;
  let priceValid = true;
  try {
    identity = parseGooglePlaceWireField('identity', raw);
  } catch (error: unknown) {
    if (error instanceof GooglePlacesWireError) return { error: invalidIdentity(index) };
    return { error: warningForPlace(index) };
  }
  try {
    price = parseGooglePlaceWireField('price', raw);
  } catch {
    price = identity;
    priceValid = false;
  }
  const record = recordOf(raw);
  const hasField = (field: string): boolean =>
    record !== undefined && Object.prototype.hasOwnProperty.call(record, field);
  const hoursPresent =
    hasField('currentOpeningHours') || hasField('regularOpeningHours') || hasField('timeZone');
  let hours: GooglePlaceWire | undefined;
  let hoursValid = true;
  try {
    const parsedHours = parseGooglePlaceWireField('opening_hours', raw);
    hours = hoursPresent ? parsedHours : undefined;
  } catch {
    hours = undefined;
    hoursValid = !hoursPresent;
  }
  let source: GooglePlaceWire | undefined;
  let sourceValid = true;
  try {
    source = parseGooglePlaceWireField('source', raw);
    sourceValid = googleSourceMetadataIsValid(source);
  } catch {
    source = undefined;
    sourceValid = false;
  }
  return {
    identity,
    price,
    priceValid,
    hoursValid,
    sourceValid,
    ...(hours === undefined ? {} : { hours }),
    ...(source === undefined ? {} : { source }),
  };
};

const normalizedPrice = (fields: ParsedPlaceFields): GoogleNormalizedValue<PriceInfo> => {
  if (!fields.priceValid) return invalidPrice();
  try {
    return normalizeGooglePrice(fields.price);
  } catch {
    return invalidPrice();
  }
};

const normalizedHours = (
  fields: ParsedPlaceFields,
  options: PlacesSearchAdapterOptions,
  evaluatedAt: string,
): GoogleNormalizedValue<OpeningHours> => {
  if (!fields.hoursValid) {
    return {
      status: 'error',
      code: 'SCHEMA_MISMATCH',
      reason: 'provider opening-hours field is invalid',
    };
  }
  if (fields.hours === undefined) return unknownHours();
  try {
    return options.normalizeOpeningHours(fields.hours, evaluatedAt);
  } catch {
    return {
      status: 'error',
      code: 'SCHEMA_MISMATCH',
      reason: 'opening-hours normalizer rejected provider data',
    };
  }
};

const validCandidate = (
  candidate: Readonly<CandidateRecord>,
  context: HarnessContext,
  recordRef: string,
  seenCandidateIds: ReadonlySet<string>,
): boolean =>
  candidate.ownerScopeRef === context.ownerScopeRef &&
  candidate.threadId === context.threadId &&
  candidate.provider === 'google_places' &&
  candidate.recordRef === recordRef &&
  !seenCandidateIds.has(candidate.candidateId);

export const buildCandidates = (
  page: GoogleTextSearchPage,
  plan: SearchPlan,
  context: HarnessContext,
  options: PlacesSearchAdapterOptions,
  evaluatedAt: string,
): CandidateBuildResult | { readonly error: Issue } => {
  const candidates: SearchPlacesOutput['candidates'] = [];
  const warnings: Issue[] = [];
  const seenRecordRefs = new Set<string>();
  const seenCandidateIds = new Set<string>();
  const observationContext = observationContextFor(context, plan.binding.locationRevision);
  let excludedCount = 0;
  let partial = false;

  for (
    let index = 0;
    index < page.places.length && candidates.length < plan.binding.limit;
    index += 1
  ) {
    const raw = page.places[index];
    const parsedFields = parsePlaceFields(raw, index);
    if ('error' in parsedFields) {
      warnings.push(parsedFields.error);
      partial = true;
      continue;
    }
    const recordRef = parsedFields.identity.id;
    const displayName = parsedFields.identity.displayName?.text;
    if (recordRef === undefined || displayName === undefined || displayName.length === 0) {
      warnings.push(warningForPlace(index));
      partial = true;
      continue;
    }
    if (seenRecordRefs.has(recordRef)) continue;
    seenRecordRefs.add(recordRef);

    const identity = normalizeGoogleIdentity(parsedFields.identity, plan.areaLabel);
    let candidate: Readonly<CandidateRecord> | undefined;
    try {
      candidate = options.registration.registerCandidate({
        ownerScopeRef: context.ownerScopeRef,
        threadId: context.threadId,
        provider: 'google_places',
        recordRef,
        displayName,
        status:
          identity.value.status === 'known'
            ? identity.value.value.businessStatus
            : candidateStatus(parsedFields.identity.businessStatus),
      });
    } catch {
      return { error: issue('MISSING_CONTEXT', null, 'candidate registration is unavailable') };
    }
    if (candidate === undefined) {
      return { error: issue('MISSING_CONTEXT', null, 'candidate registration is unavailable') };
    }
    if (!validCandidate(candidate, context, recordRef, seenCandidateIds)) {
      return {
        error: issue('MISSING_CONTEXT', null, 'candidate registration returned invalid ownership'),
      };
    }
    if (candidate.excluded || plan.binding.excludeCandidateIds.includes(candidate.candidateId)) {
      excludedCount += 1;
      continue;
    }
    seenCandidateIds.add(candidate.candidateId);

    const sources = sourceFor(parsedFields.source, recordRef);
    const sourceError = parsedFields.sourceValid
      ? undefined
      : issue('SCHEMA_MISMATCH', 'source', 'provider attribution metadata is invalid');
    const identityResult =
      sourceError === undefined
        ? registerKnown(
            identity.value,
            'identity',
            PlaceIdentitySchema,
            candidate.candidateId,
            observationContext,
            sources,
            options.registration,
            (value) => value,
          )
        : fieldError<PlaceIdentity>(sourceError);
    const openingResult =
      sourceError === undefined
        ? registerKnown(
            normalizedHours(parsedFields, options, evaluatedAt),
            'opening_hours',
            OpeningHoursSchema,
            candidate.candidateId,
            observationContext,
            sources,
            options.registration,
            (value) => value,
          )
        : fieldError<OpeningHours>(sourceError);
    const priceResult =
      sourceError === undefined
        ? registerKnown(
            normalizedPrice(parsedFields),
            'price',
            PriceInfoSchema,
            candidate.candidateId,
            observationContext,
            sources,
            options.registration,
            (value) => value,
          )
        : fieldError<PriceInfo>(sourceError);
    if (
      identityResult.status === 'error' ||
      openingResult.status === 'error' ||
      priceResult.status === 'error'
    ) {
      partial = true;
    }
    candidates.push({
      candidateId: candidate.candidateId,
      identity: identityResult,
      openingHours: openingResult,
      price: priceResult,
    });
  }
  return { candidates, warnings, excludedCount, partial };
};
