import * as v from 'valibot';
import {
  AnyFieldResultSchema,
  DetailFieldSchema,
  GetPlaceDetailsOutputSchema,
  type DetailField,
  type GetPlaceDetailsOutput,
  type Issue,
  type Result,
} from '@ima/core';
import { issue, resultError } from './adapter-support';
import type { GooglePlaceDetailsError, GooglePlaceDetailsField } from './types';

export const providerIssue = (error: GooglePlaceDetailsError, path: string): Issue => {
  switch (error.code) {
    case 'MISSING_API_KEY':
      return issue('MISSING_CONTEXT', path, 'place details provider is not configured');
    case 'INVALID_REQUEST':
      return issue('INVALID_ARGUMENT', path, 'place details request was rejected');
    case 'RATE_LIMITED':
      return issue(
        'RATE_LIMITED',
        path,
        'place details provider is rate limited',
        true,
        error.retryAfterMs,
      );
    case 'NOT_FOUND':
      return issue('UNKNOWN_CANDIDATE', path, 'place details candidate was not found');
    case 'TIMEOUT':
      return issue('TIMEOUT', path, 'place details provider timed out', true);
    case 'CANCELLED':
      return issue('CANCELLED', path, 'place details read was cancelled');
    case 'UPSTREAM_UNAVAILABLE':
      return issue('UPSTREAM_UNAVAILABLE', path, 'place details provider is unavailable', true);
    case 'SCHEMA_MISMATCH':
      return issue('SCHEMA_MISMATCH', path, 'place details provider response was invalid');
  }
};

export const unknownProviderIssue = (path: string): Issue =>
  issue('UPSTREAM_UNAVAILABLE', path, 'place details provider is unavailable', true);

export const responseFailureFields = (
  fields: readonly GooglePlaceDetailsField[],
): readonly (readonly [GooglePlaceDetailsField, Issue])[] =>
  fields.map(
    (field) =>
      [
        field,
        issue('SCHEMA_MISMATCH', field, 'provider response identity or field set is invalid'),
      ] as const,
  );

export const addProviderFailure = (
  fields: Record<string, unknown>,
  providerFailure: readonly (readonly [GooglePlaceDetailsField, Issue])[],
): void => {
  for (const [field, error] of providerFailure) fields[field] = { status: 'error', error };
};

export const warningFor = (field: DetailField, result: unknown): Issue | undefined => {
  const parsed = v.safeParse(AnyFieldResultSchema, result);
  if (!parsed.success || parsed.output.status === 'known') return undefined;
  if (parsed.output.status === 'error') return parsed.output.error;
  if (parsed.output.status === 'unsupported') {
    return issue('UNSUPPORTED_FIELD', field, 'field is unsupported');
  }
  return issue('MISSING_EVIDENCE', field, 'field is unavailable');
};

export const outputResult = (
  items: readonly { readonly candidateId: string; readonly fields: Record<string, unknown> }[],
): Result<GetPlaceDetailsOutput> => {
  const parsed = v.safeParse(GetPlaceDetailsOutputSchema, { items });
  if (!parsed.success) {
    return resultError(issue('SCHEMA_MISMATCH', 'result', 'details result is invalid'));
  }
  const warnings = parsed.output.items.flatMap((item) =>
    Object.entries(item.fields).flatMap(([field, result]) => {
      const parsedField = v.safeParse(DetailFieldSchema, field);
      if (!parsedField.success) return [];
      const warning = warningFor(parsedField.output, result);
      return warning === undefined ? [] : [warning];
    }),
  );
  return {
    status: warnings.length === 0 ? 'ok' : 'partial',
    data: parsed.output,
    warnings,
  };
};

export const providerIssueForFields = (
  error: GooglePlaceDetailsError,
  fields: readonly GooglePlaceDetailsField[],
): readonly (readonly [GooglePlaceDetailsField, Issue])[] =>
  fields.map((field) => [field, providerIssue(error, field)] as const);

export const unknownIssueForFields = (
  fields: readonly GooglePlaceDetailsField[],
): readonly (readonly [GooglePlaceDetailsField, Issue])[] =>
  fields.map((field) => [field, unknownProviderIssue(field)] as const);
