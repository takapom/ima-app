import * as v from 'valibot';
import {
  GetPlaceDetailsInputSchema,
  type CandidateRecord,
  type CancellationToken,
  type GetPlaceDetailsInput,
  type GetPlaceDetailsOutput,
  type HarnessContext,
  type Issue,
  type PlaceDetailsPort,
  type Result,
} from '@ima/core';
import {
  areaLabelFor,
  cancelled,
  clockNow,
  contextIsValid,
  executionIsCurrent,
  invalidCandidateField,
  isSignalAborted,
  isSupportedField,
  issue,
  observationContextFor,
  responseMatches,
  unsupportedField,
} from './adapter-support';
import {
  addProviderFailure,
  outputResult,
  providerIssueForFields,
  responseFailureFields,
  unknownIssueForFields,
} from './adapter-result';
import {
  normalizeAndRegisterField,
  providerIdFrom,
  sourceInfo,
  storedFieldFor,
} from './adapter-normalization';
import {
  GooglePlaceDetailsError,
  type GooglePlaceDetailsField,
  type GooglePlaceDetailsResponse,
} from './types';
import type { PlacesDetailsAdapterOptions } from './adapter-types';

export type { PlacesDetailsAdapterOptions } from './adapter-types';

type DetailsRequest = GetPlaceDetailsInput['requests'][number];
type DetailsItem = { readonly candidateId: string; readonly fields: Record<string, unknown> };

type CandidateReadResult =
  { readonly candidate: Readonly<CandidateRecord> | undefined } | { readonly error: Issue };

type PendingDetails = {
  readonly index: number;
  readonly candidate: Readonly<CandidateRecord>;
  readonly request: DetailsRequest;
  readonly fields: Record<string, unknown>;
  readonly fetchFields: readonly GooglePlaceDetailsField[];
  readonly areaLabel: string | undefined;
};

const clearHandoff = (options: PlacesDetailsAdapterOptions): void => {
  try {
    options.savedReferenceHandoff?.clear();
  } catch {
    // Handoff cleanup is best effort and must not replace the original result.
  }
};

const readCandidate = (
  options: PlacesDetailsAdapterOptions,
  context: HarnessContext,
  candidateId: string,
): CandidateReadResult => {
  try {
    return {
      candidate: options.registry.readCandidate(
        { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
        candidateId,
      ),
    };
  } catch {
    return { error: issue('MISSING_CONTEXT', candidateId, 'candidate registry is unavailable') };
  }
};

const reusableField = (
  options: PlacesDetailsAdapterOptions,
  context: HarnessContext,
  candidate: Readonly<CandidateRecord>,
  field: GooglePlaceDetailsField,
): unknown => {
  try {
    const reused = options.registry.evaluateObservationReuse({
      scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      candidateId: candidate.candidateId,
      field,
      context: observationContextFor(context, options.originRefFor?.(context) ?? null),
    });
    if (reused.status !== 'reusable') return undefined;
    const result = storedFieldFor(reused.observation, field);
    return typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      result.status === 'known'
      ? result
      : undefined;
  } catch {
    return undefined;
  }
};

/** A refresh blocks every old value before the first provider byte is requested. */
const invalidateBeforeFetch = (
  options: PlacesDetailsAdapterOptions,
  context: HarnessContext,
  candidate: Readonly<CandidateRecord>,
  fields: readonly GooglePlaceDetailsField[],
): Issue | undefined => {
  for (const field of fields) {
    try {
      options.registry.invalidateObservationReuse(
        { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
        candidate.candidateId,
        field,
      );
    } catch {
      return issue('MISSING_CONTEXT', field, 'observation registry is unavailable');
    }
  }
  return undefined;
};

const processResponse = (
  work: PendingDetails,
  response: GooglePlaceDetailsResponse,
  observedAt: string,
  context: HarnessContext,
  cancellation: CancellationToken,
  signal: AbortSignal | undefined,
  options: PlacesDetailsAdapterOptions,
): Result<DetailsItem> | DetailsItem => {
  if (cancellation.isCancelled() || isSignalAborted(signal)) {
    clearHandoff(options);
    return cancelled();
  }
  if (!responseMatches(response, work.candidate.recordRef, work.fetchFields)) {
    addProviderFailure(work.fields, responseFailureFields(work.fetchFields));
    return { candidateId: work.request.candidateId, fields: work.fields };
  }
  const providerId = providerIdFrom(response.body);
  const source = sourceInfo(response.body, work.candidate.recordRef);
  const sourceConflict = providerId !== work.candidate.recordRef;
  const observationContext = observationContextFor(
    context,
    options.originRefFor?.(context) ?? null,
  );
  for (const field of work.fetchFields) {
    if (cancellation.isCancelled() || isSignalAborted(signal)) {
      clearHandoff(options);
      return cancelled();
    }
    if (sourceConflict) {
      work.fields[field] = {
        status: 'error',
        error: issue('SOURCE_CONFLICT', field, 'provider record id does not match candidate'),
      };
      continue;
    }
    if (!source.ok) {
      work.fields[field] = {
        status: 'error',
        error: issue('SCHEMA_MISMATCH', field, 'provider attribution metadata is invalid'),
      };
      continue;
    }
    if (field === 'identity' && work.areaLabel === undefined) {
      work.fields[field] = {
        status: 'error',
        error: issue('MISSING_CONTEXT', field, 'Host area label is unavailable'),
      };
      continue;
    }
    try {
      work.fields[field] = normalizeAndRegisterField(
        field,
        response.body,
        work.areaLabel ?? '',
        observedAt,
        work.candidate.candidateId,
        observationContext,
        source.sources,
        observedAt,
        options,
      );
    } catch {
      work.fields[field] = {
        status: 'error',
        error: issue('SCHEMA_MISMATCH', field, 'provider field normalization failed'),
      };
    }
  }
  return { candidateId: work.request.candidateId, fields: work.fields };
};

const runPending = async (
  work: PendingDetails,
  context: HarnessContext,
  cancellation: CancellationToken,
  signal: AbortSignal | undefined,
  options: PlacesDetailsAdapterOptions,
): Promise<Result<DetailsItem> | DetailsItem> => {
  const discardHandoff = (): void => {
    try {
      options.savedReferenceHandoff?.discardForCandidate({
        candidateId: work.candidate.candidateId,
        scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
        turnId: context.turnId,
        revision: context.revision,
      });
    } catch {
      // A failed cleanup must not turn a cancellation into a provider error.
    }
  };
  if (cancellation.isCancelled() || isSignalAborted(signal)) {
    discardHandoff();
    return cancelled();
  }
  const invalidationError = invalidateBeforeFetch(
    options,
    context,
    work.candidate,
    work.fetchFields,
  );
  if (invalidationError !== undefined) {
    discardHandoff();
    return { status: 'error', error: invalidationError };
  }
  if (cancellation.isCancelled() || isSignalAborted(signal)) {
    clearHandoff(options);
    return cancelled();
  }
  const beforeFetch = clockNow(options);
  if (typeof beforeFetch !== 'string') {
    discardHandoff();
    return { status: 'error', error: beforeFetch };
  }
  let handoff:
    | ReturnType<
        NonNullable<PlacesDetailsAdapterOptions['savedReferenceHandoff']>['takeForCandidate']
      >
    | undefined;
  try {
    handoff = options.savedReferenceHandoff?.takeForCandidate({
      candidateId: work.candidate.candidateId,
      scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      turnId: context.turnId,
      revision: context.revision,
      fields: work.fetchFields,
      now: beforeFetch,
    });
  } catch {
    discardHandoff();
    return {
      status: 'error',
      error: issue('MISSING_CONTEXT', 'handoff', 'saved reference handoff is unavailable'),
    };
  }
  if (handoff?.status === 'expired') {
    addProviderFailure(
      work.fields,
      work.fetchFields.map(
        (field) =>
          [field, issue('STALE_TURN', field, 'saved reference details have expired')] as const,
      ),
    );
    return { candidateId: work.request.candidateId, fields: work.fields };
  }
  if (handoff?.status === 'invalid') {
    addProviderFailure(
      work.fields,
      work.fetchFields.map(
        (field) =>
          [
            field,
            issue('SCHEMA_MISMATCH', field, 'saved reference details handoff is invalid'),
          ] as const,
      ),
    );
    return { candidateId: work.request.candidateId, fields: work.fields };
  }
  if (handoff?.status === 'ready') {
    return processResponse(
      work,
      handoff.response,
      handoff.observedAt,
      context,
      cancellation,
      signal,
      options,
    );
  }
  let response: GooglePlaceDetailsResponse;
  try {
    response = await options.transport.read(
      { placeId: work.candidate.recordRef, fields: [...work.fetchFields] },
      signal,
    );
  } catch (error: unknown) {
    if (cancellation.isCancelled() || isSignalAborted(signal)) return cancelled();
    const failures =
      error instanceof GooglePlaceDetailsError
        ? providerIssueForFields(error, work.fetchFields)
        : unknownIssueForFields(work.fetchFields);
    addProviderFailure(work.fields, failures);
    return { candidateId: work.request.candidateId, fields: work.fields };
  }
  const afterFetch = clockNow(options);
  if (typeof afterFetch !== 'string') return { status: 'error', error: afterFetch };
  return processResponse(work, response, afterFetch, context, cancellation, signal, options);
};

export const createPlacesDetailsAdapter = (
  options: PlacesDetailsAdapterOptions,
): PlaceDetailsPort => ({
  async read(input, context, execution, cancellation): Promise<Result<GetPlaceDetailsOutput>> {
    if (cancellation.isCancelled()) {
      clearHandoff(options);
      return cancelled();
    }
    if (!contextIsValid(context)) {
      return {
        status: 'error',
        error: issue('MISSING_CONTEXT', null, 'place details context is invalid'),
      };
    }
    if (!executionIsCurrent(context, execution)) {
      return {
        status: 'error',
        error: issue('STALE_TURN', null, 'details execution does not match this turn'),
      };
    }
    const parsedInput = v.safeParse(GetPlaceDetailsInputSchema, input);
    if (!parsedInput.success) {
      return {
        status: 'error',
        error: issue('INVALID_ARGUMENT', 'input', 'details input is invalid'),
      };
    }
    let signal: AbortSignal | undefined;
    try {
      signal = options.signalFor?.(execution);
    } catch {
      return {
        status: 'error',
        error: issue('MISSING_CONTEXT', null, 'details cancellation bridge is unavailable'),
      };
    }
    if (isSignalAborted(signal)) {
      clearHandoff(options);
      return cancelled();
    }

    const items: Array<DetailsItem | undefined> = [];
    const pending: PendingDetails[] = [];
    for (const [index, request] of parsedInput.output.requests.entries()) {
      const fields: Record<string, unknown> = {};
      const candidateResult = readCandidate(options, context, request.candidateId);
      if ('error' in candidateResult) return { status: 'error', error: candidateResult.error };
      const candidate = candidateResult.candidate;
      if (candidate === undefined) {
        for (const field of request.fields) {
          fields[field] = invalidCandidateField(
            field,
            'UNKNOWN_CANDIDATE',
            'candidate is not owned by this thread',
          );
        }
        items[index] = { candidateId: request.candidateId, fields };
        continue;
      }
      if (candidate.excluded) {
        for (const field of request.fields) {
          fields[field] = invalidCandidateField(
            field,
            'EXCLUDED_CANDIDATE',
            'candidate is excluded',
          );
        }
        items[index] = { candidateId: request.candidateId, fields };
        continue;
      }
      if (candidate.provider !== 'google_places') {
        for (const field of request.fields) {
          fields[field] = unsupportedField(
            field,
            'candidate provider does not supply Google Place Details',
          );
        }
        items[index] = { candidateId: request.candidateId, fields };
        continue;
      }
      const fetchList: GooglePlaceDetailsField[] = [];
      for (const field of request.fields) {
        if (!isSupportedField(field)) {
          fields[field] = unsupportedField(field);
          continue;
        }
        if (parsedInput.output.freshness === 'reuse_valid') {
          const reused = reusableField(options, context, candidate, field);
          if (reused !== undefined) {
            fields[field] = reused;
            continue;
          }
        }
        fetchList.push(field);
      }
      if (fetchList.length === 0) {
        items[index] = { candidateId: request.candidateId, fields };
      } else {
        pending.push({
          index,
          candidate,
          request,
          fields,
          fetchFields: fetchList,
          areaLabel: areaLabelFor(candidate, context, options),
        });
      }
    }
    for (const work of pending) {
      const result = await runPending(work, context, cancellation, signal, options);
      if ('status' in result) {
        if (result.status === 'error') {
          clearHandoff(options);
          return { status: 'error', error: result.error };
        }
        return {
          status: 'error',
          error: issue('SCHEMA_MISMATCH', 'result', 'pending result is invalid'),
        };
      }
      items[work.index] = result;
    }
    if (cancellation.isCancelled() || isSignalAborted(signal)) {
      clearHandoff(options);
      return cancelled();
    }
    const finalItems = items.filter((item): item is DetailsItem => item !== undefined);
    if (finalItems.length !== parsedInput.output.requests.length) {
      return {
        status: 'error',
        error: issue('SCHEMA_MISMATCH', 'result', 'details items are incomplete'),
      };
    }
    return outputResult(finalItems);
  },
});
