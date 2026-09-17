import type {
  CancellationToken,
  GetPlaceDetailsInput,
  GetPlaceDetailsOutput,
  HarnessContext,
  PlaceDetailsPort,
  PlaceSearchPort,
  Result,
  SearchPlacesInput,
  SearchPlacesOutput,
  ToolExecutionContext,
} from '@ima/core';

const disabledProviderIssue = (path: string) => ({
  code: 'MISSING_CONTEXT' as const,
  path,
  retryable: false,
  retryAfterMs: null,
  message: 'provider capability is disabled',
  missingFields: [],
});

export const disabledSearchPort: PlaceSearchPort = {
  search: (
    _input: SearchPlacesInput,
    _context: HarnessContext,
    _execution: ToolExecutionContext,
    _cancellation: CancellationToken,
  ): Promise<Result<SearchPlacesOutput>> =>
    Promise.resolve({
      status: 'error',
      error: disabledProviderIssue('search_places'),
    }),
};

export const disabledDetailsPort: PlaceDetailsPort = {
  read: (
    _input: GetPlaceDetailsInput,
    _context: HarnessContext,
    _execution: ToolExecutionContext,
    _cancellation: CancellationToken,
  ): Promise<Result<GetPlaceDetailsOutput>> =>
    Promise.resolve({
      status: 'error',
      error: disabledProviderIssue('get_place_details'),
    }),
};
