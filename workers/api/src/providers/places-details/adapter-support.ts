import * as v from 'valibot';
import {
  HarnessContextSchema,
  IsoTimestampSchema,
  Text,
  type CandidateRecord,
  type DetailField,
  type FieldResult,
  type HarnessContext,
  type Issue,
  type ObservationContext,
  type RegistryJsonValue,
  type ToolExecutionContext,
} from '@ima/core';
import {
  GOOGLE_PLACE_DETAILS_FIELDS,
  type GooglePlaceDetailsField,
  type GooglePlaceDetailsResponse,
} from './types';
import type { PlacesDetailsAdapterOptions } from './adapter-types';

export const issue = (
  code: Issue['code'],
  path: string | null,
  message: string,
  retryable = false,
  retryAfterMs: number | null = null,
): Issue => ({
  code,
  path,
  retryable,
  retryAfterMs,
  message,
  missingFields: [],
});

export const resultError = (error: Issue): { status: 'error'; error: Issue } => ({
  status: 'error',
  error,
});

export const cancelled = (): { status: 'error'; error: Issue } =>
  resultError(issue('CANCELLED', null, 'place details read was cancelled'));

export const fieldError = <T>(error: Issue): FieldResult<T> => ({ status: 'error', error });

export const isSupportedField = (field: DetailField): field is GooglePlaceDetailsField =>
  GOOGLE_PLACE_DETAILS_FIELDS.some((candidate) => candidate === field);

export const executionIsCurrent = (
  context: HarnessContext,
  execution: ToolExecutionContext,
): boolean =>
  execution.operation === 'get_place_details' &&
  execution.threadId === context.threadId &&
  execution.turnId === context.turnId &&
  execution.revision === context.revision;

export const observationContextFor = (
  context: HarnessContext,
  originRef: string | null = null,
): ObservationContext => ({
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
  capabilityVersion: context.capabilities.version,
  locationRevision: context.location.revision,
  originRef,
  homeStationRef: context.preferences.homeStationRef,
  minimumStayMinutes: context.preferences.minimumStayMinutes,
  timeContext: 'now',
});

export const invalidCandidateField = (
  field: DetailField,
  code: Issue['code'],
  message: string,
): FieldResult<RegistryJsonValue> => fieldError(issue(code, field, message));

export const unsupportedField = (
  field: DetailField,
  reason = `${field} is supplied by another provider`,
): FieldResult<RegistryJsonValue> => ({ status: 'unsupported', reason });

export const isSignalAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && signal.aborted;

export const clockNow = (options: PlacesDetailsAdapterOptions): string | Issue => {
  let value: string;
  try {
    value = options.clock.now();
  } catch {
    return issue('MISSING_CONTEXT', null, 'place details clock is unavailable');
  }
  return v.safeParse(IsoTimestampSchema, value).success
    ? value
    : issue('MISSING_CONTEXT', null, 'place details clock returned an invalid timestamp');
};

export const areaLabelFor = (
  candidate: Readonly<CandidateRecord>,
  context: HarnessContext,
  options: PlacesDetailsAdapterOptions,
): string | undefined => {
  try {
    const value = options.areaLabelFor(candidate, context);
    return v.safeParse(Text(160), value).success ? value : undefined;
  } catch {
    return undefined;
  }
};

export const responseMatches = (
  response: GooglePlaceDetailsResponse,
  recordRef: string,
  fields: readonly GooglePlaceDetailsField[],
): boolean => {
  if (response.placeId !== recordRef) return false;
  const actual = new Set(response.fields);
  return actual.size === fields.length && fields.every((field) => actual.has(field));
};

export const contextIsValid = (context: HarnessContext): boolean =>
  v.safeParse(HarnessContextSchema, context).success;
