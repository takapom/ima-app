import * as v from 'valibot';
import { SearchPlacesInputSchema, type HarnessContext, type SearchPlacesInput } from '@ima/core';
import type {
  GoogleLocationBias,
  GoogleTextSearchRequest,
  PlacesSearchArea,
  PlacesSearchCursorBinding,
} from './types';
import {
  issue,
  type ContinueInput,
  type PlanResult,
  type PlacesSearchContinuation,
  type PlacesSearchContinuationResolution,
  type SearchInput,
} from './adapter-types';

export const isValidSearchInput = (input: SearchPlacesInput): boolean =>
  v.safeParse(SearchPlacesInputSchema, input).success;

export const areaLabelFor = (area: PlacesSearchArea, _context: HarnessContext): string => {
  if (area.kind === 'named_area') return area.name;
  return '現在地周辺';
};

const locationIssue = (context: HarnessContext) =>
  context.location.status === 'reduced'
    ? issue('LOCATION_IMPRECISE', 'area', 'current location is not precise enough')
    : issue('LOCATION_REQUIRED', 'area', 'current location is unavailable');

const currentLocationBias = (
  area: PlacesSearchArea,
  context: HarnessContext,
): GoogleLocationBias | undefined => {
  if (area.kind !== 'current_location') return undefined;
  const coordinates = context.location.coordinates;
  if (context.location.status !== 'available' || coordinates === null) return undefined;
  return {
    circle: {
      center: { latitude: coordinates.lat, longitude: coordinates.lng },
      radius: area.radiusMeters,
    },
  };
};

const queryFor = (query: string, area: PlacesSearchArea): string =>
  area.kind === 'named_area' ? `${query} ${area.name}` : query;

export const cursorBindingInput = (
  binding: PlacesSearchCursorBinding,
): Extract<SearchPlacesInput, { mode: 'search' }> => ({
  mode: 'search',
  query: binding.query,
  area: binding.area,
  openNow: binding.openNow,
  limit: binding.limit,
  excludeCandidateIds: [...binding.excludeCandidateIds],
});

const isSafeCursorBinding = (binding: PlacesSearchCursorBinding): boolean =>
  isValidSearchInput(cursorBindingInput(binding)) &&
  Number.isSafeInteger(binding.locationRevision) &&
  binding.locationRevision >= 0;

const bindingFor = (input: SearchInput, context: HarnessContext): PlacesSearchCursorBinding => ({
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
  query: input.query,
  area: input.area,
  openNow: input.openNow,
  limit: input.limit,
  excludeCandidateIds: [...input.excludeCandidateIds],
  locationRevision: context.location.revision,
});

export const planForSearch = (input: SearchInput, context: HarnessContext): PlanResult => {
  if (input.area.kind === 'current_location') {
    if (context.location.status !== 'available' || context.location.coordinates === null) {
      return { ok: false, error: locationIssue(context) };
    }
  }
  const binding = bindingFor(input, context);
  const locationBias = currentLocationBias(input.area, context);
  const request: GoogleTextSearchRequest = {
    textQuery: queryFor(input.query, input.area),
    openNow: input.openNow,
    pageSize: input.limit,
    ...(locationBias === undefined ? {} : { locationBias }),
  };
  return {
    ok: true,
    plan: { binding, request, areaLabel: areaLabelFor(input.area, context) },
  };
};

export const planForContinue = async (
  input: ContinueInput,
  context: HarnessContext,
  continuation: PlacesSearchContinuation,
): Promise<PlanResult> => {
  let resolved: PlacesSearchContinuationResolution;
  try {
    resolved = await continuation.resolve(input.cursor);
  } catch {
    return {
      ok: false,
      error: issue('MISSING_CONTEXT', 'cursor', 'search continuation state is unavailable'),
    };
  }
  if (!resolved.ok) {
    return {
      ok: false,
      error:
        resolved.code === 'CURSOR_EXPIRED'
          ? issue('CURSOR_EXPIRED', 'cursor', 'search cursor has expired')
          : issue('INVALID_ARGUMENT', 'cursor', 'search cursor is invalid'),
    };
  }
  const { binding } = resolved;
  if (
    !isSafeCursorBinding(binding) ||
    binding.ownerScopeRef !== context.ownerScopeRef ||
    binding.threadId !== context.threadId ||
    binding.locationRevision !== context.location.revision ||
    typeof resolved.providerPageToken !== 'string' ||
    resolved.providerPageToken.length === 0 ||
    resolved.providerPageToken.length > 1_024
  ) {
    return {
      ok: false,
      error: issue('INVALID_ARGUMENT', 'cursor', 'search cursor does not match this context'),
    };
  }
  const base = planForSearch(cursorBindingInput(binding), context);
  if (!base.ok) return base;
  return {
    ok: true,
    plan: {
      ...base.plan,
      request: { ...base.plan.request, pageToken: resolved.providerPageToken },
      providerPageToken: resolved.providerPageToken,
    },
  };
};
