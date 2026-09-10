import type {
  Issue,
  IssueCode,
  OpeningHours,
  Result,
  SearchPlacesInput,
  SearchPlacesOutput,
  HarnessContext,
  ToolExecutionContext,
} from '@ima/core';
import type { GoogleTextSearchRequest, PlacesSearchCursorBinding } from './types';
import type { GoogleTextSearchTransport } from './transport';
import type { GoogleNormalizedValue } from '../places/values';
import type { GooglePlaceWire } from '../places/wire';
import type { PlacesSearchRegistration } from './registration';
import type { PlacesSearchContinuation } from './continuation';

export type { PlacesSearchContinuation, PlacesSearchContinuationResolution } from './continuation';

export type PlacesSearchOpeningHoursNormalizer = (
  place: GooglePlaceWire,
  evaluatedAt: string,
) => GoogleNormalizedValue<OpeningHours>;

export type PlacesSearchAdapterOptions = {
  readonly transport: GoogleTextSearchTransport;
  readonly continuation: PlacesSearchContinuation;
  readonly registration: PlacesSearchRegistration;
  readonly nextSearchId: () => string;
  readonly clock: () => string;
  /** Shared M12 hours normalizer is injected when that unit is available. */
  readonly normalizeOpeningHours: PlacesSearchOpeningHoursNormalizer;
  /** Runtime may bridge its cancellation signal to the provider fetch. */
  readonly signalFor?: (execution: ToolExecutionContext) => AbortSignal | undefined;
  /** Current-origin routes share their structured context with search evidence. */
  readonly originRefFor?: (context: HarnessContext) => string | undefined;
};

export type SearchPlan = {
  readonly binding: PlacesSearchCursorBinding;
  readonly request: GoogleTextSearchRequest;
  readonly areaLabel: string;
  readonly providerPageToken?: string;
};

export type PlanResult =
  { readonly ok: true; readonly plan: SearchPlan } | { readonly ok: false; readonly error: Issue };

export type CandidateBuildResult = {
  readonly candidates: SearchPlacesOutput['candidates'];
  readonly warnings: readonly Issue[];
  readonly excludedCount: number;
  readonly partial: boolean;
};

export type SearchField = 'identity' | 'opening_hours' | 'price';

export const issue = (
  code: IssueCode,
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

export const resultError = <T>(error: Issue): Result<T> => ({ status: 'error', error });

export const cancelled = <T>(): Result<T> =>
  resultError(issue('CANCELLED', null, 'search was cancelled'));

export type SearchInput = Extract<SearchPlacesInput, { mode: 'search' }>;
export type ContinueInput = Extract<SearchPlacesInput, { mode: 'continue' }>;
