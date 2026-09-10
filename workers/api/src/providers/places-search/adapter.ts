import * as v from 'valibot';
import {
  IsoTimestampSchema,
  SearchIdSchema,
  SearchPlacesOutputSchema,
  type HarnessContext,
  type Issue,
  type PlaceSearchPort,
  type Result,
  type SearchPlacesOutput,
  type ToolExecutionContext,
} from '@ima/core';
import { GoogleTextSearchError, type GoogleTextSearchPage } from './types';
import { buildCandidates } from './adapter-candidates';
import { isValidSearchInput, planForContinue, planForSearch } from './adapter-planning';
import { cancelled, issue, resultError, type PlacesSearchAdapterOptions } from './adapter-types';

export type {
  PlacesSearchAdapterOptions,
  PlacesSearchContinuation,
  PlacesSearchContinuationResolution,
  PlacesSearchOpeningHoursNormalizer,
} from './adapter-types';

const providerIssue = (error: GoogleTextSearchError): Issue => {
  switch (error.code) {
    case 'MISSING_API_KEY':
      return issue('MISSING_CONTEXT', null, 'search provider is unavailable');
    case 'INVALID_REQUEST':
      return issue('INVALID_ARGUMENT', null, 'search request was rejected');
    case 'RATE_LIMITED':
      return issue(
        'RATE_LIMITED',
        null,
        'search provider is rate limited',
        true,
        error.retryAfterMs,
      );
    case 'TIMEOUT':
      return issue('TIMEOUT', null, 'search provider timed out', true);
    case 'CANCELLED':
      return issue('CANCELLED', null, 'search was cancelled');
    case 'SCHEMA_MISMATCH':
      return issue('SCHEMA_MISMATCH', null, 'search provider returned an invalid response');
    case 'UPSTREAM_UNAVAILABLE':
      return issue('UPSTREAM_UNAVAILABLE', null, 'search provider is unavailable', true);
  }
};

const executionIsCurrent = (context: HarnessContext, execution: ToolExecutionContext): boolean =>
  execution.operation === 'search_places' &&
  execution.threadId === context.threadId &&
  execution.turnId === context.turnId &&
  execution.revision === context.revision;

const outputResult = (
  plan: { readonly areaLabel: string; readonly binding: { readonly openNow: boolean } },
  searchId: string,
  built: {
    readonly candidates: SearchPlacesOutput['candidates'];
    readonly warnings: readonly Issue[];
    readonly excludedCount: number;
    readonly partial: boolean;
  },
  nextCursor: string | null,
): Result<SearchPlacesOutput> => {
  const output: SearchPlacesOutput = {
    searchId,
    candidates: built.candidates,
    applied: {
      areaDescription: plan.areaLabel,
      openNow: plan.binding.openNow,
      excludedCount: built.excludedCount,
    },
    nextCursor,
    coverage: 'provider_results',
  };
  const parsed = v.safeParse(SearchPlacesOutputSchema, output);
  if (!parsed.success) {
    return resultError(issue('SCHEMA_MISMATCH', 'result', 'search result is invalid'));
  }
  return {
    status: built.partial || built.warnings.length > 0 ? 'partial' : 'ok',
    data: parsed.output,
    warnings: [...built.warnings],
  };
};

const readObservationTime = (clock: () => string): string | Issue => {
  let value: string;
  try {
    value = clock();
  } catch {
    return issue('MISSING_CONTEXT', null, 'search clock is unavailable');
  }
  return v.safeParse(IsoTimestampSchema, value).success
    ? value
    : issue('MISSING_CONTEXT', null, 'search clock returned an invalid timestamp');
};

export const createPlacesSearchAdapter = (
  options: PlacesSearchAdapterOptions,
): PlaceSearchPort => ({
  async search(input, context, execution, cancellation): Promise<Result<SearchPlacesOutput>> {
    if (cancellation.isCancelled()) return cancelled();
    if (!executionIsCurrent(context, execution)) {
      return resultError(issue('STALE_TURN', null, 'search execution does not match this turn'));
    }
    if (!isValidSearchInput(input)) {
      return resultError(issue('INVALID_ARGUMENT', 'input', 'search input is invalid'));
    }

    const planned =
      input.mode === 'search'
        ? planForSearch(input, context)
        : await planForContinue(input, context, options.continuation);
    if (!planned.ok) return resultError(planned.error);
    if (cancellation.isCancelled()) return cancelled();

    let signal: AbortSignal | undefined;
    try {
      signal = options.signalFor?.(execution);
    } catch {
      return resultError(
        issue('MISSING_CONTEXT', null, 'search cancellation bridge is unavailable'),
      );
    }
    if (signal?.aborted === true) return cancelled();

    let page: GoogleTextSearchPage;
    try {
      page = await options.transport.search(planned.plan.request, signal);
    } catch (error: unknown) {
      if (error instanceof GoogleTextSearchError) return resultError(providerIssue(error));
      return resultError(
        issue('UPSTREAM_UNAVAILABLE', null, 'search provider is unavailable', true),
      );
    }
    if (cancellation.isCancelled() || signal?.aborted) return cancelled();

    const observedAt = readObservationTime(options.clock);
    if (typeof observedAt !== 'string') return resultError(observedAt);

    let searchId: string;
    try {
      searchId = options.nextSearchId();
    } catch {
      return resultError(issue('MISSING_CONTEXT', null, 'search ID service is unavailable'));
    }
    if (!v.safeParse(SearchIdSchema, searchId).success) {
      return resultError(issue('MISSING_CONTEXT', null, 'search ID is invalid'));
    }

    const built = buildCandidates(page, planned.plan, context, options, observedAt);
    if ('error' in built) return resultError(built.error);

    let nextCursor: string | null = null;
    if (page.nextPageToken !== null) {
      try {
        nextCursor = await options.continuation.issue({
          ...planned.plan.binding,
          providerPageToken: page.nextPageToken,
        });
      } catch {
        return resultError(
          issue('MISSING_CONTEXT', 'cursor', 'search continuation is unavailable'),
        );
      }
      if (cancellation.isCancelled() || signal?.aborted) return cancelled();
    }
    return outputResult(planned.plan, searchId, built, nextCursor);
  },
});
