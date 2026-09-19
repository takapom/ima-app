import type {
  CancellationToken,
  HarnessContext,
  ToolExecutionContext,
} from '@worker/application/ports/context';
import type {
  GetPlaceDetailsInput,
  GetPlaceDetailsOutput,
  PlaceDetailsPort,
  PlaceSearchPort,
  SearchPlacesInput,
  SearchPlacesOutput,
} from '@worker/application/ports/operations';
import type { Result } from '@worker/domain/result';

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
