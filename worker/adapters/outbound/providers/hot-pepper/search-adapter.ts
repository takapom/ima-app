import * as v from 'valibot';
import {
  SearchPlacesInputSchema,
  SearchPlacesOutputSchema,
  type PlaceSearchPort,
  type HarnessContext,
} from '@ima/core';
import type { PlacesSearchContinuation } from '@worker/adapters/outbound/providers/places-search/continuation';
import type { PlacesSearchCursorBinding } from '@worker/adapters/outbound/providers/places-search/types';
import type { PlacesSearchRegistration } from '@worker/adapters/outbound/providers/places-search/registration';
import type { HotPepperTransport } from '@worker/adapters/outbound/providers/hot-pepper/transport';
import {
  HotPepperError,
  type HotPepperSearchRequest,
} from '@worker/adapters/outbound/providers/hot-pepper/types';
import type { HotPepperShopWire } from '@worker/adapters/outbound/providers/hot-pepper/wire';
import {
  hotPepperIssue,
  hotPepperProviderIssue,
  registerHotPepperField,
} from '@worker/adapters/outbound/providers/hot-pepper/place-observations';
import type { ToolExecutionContext } from '@ima/core';

type SearchOptions = {
  readonly transport: HotPepperTransport;
  readonly registration: PlacesSearchRegistration;
  readonly continuation: PlacesSearchContinuation;
  readonly nextSearchId: () => string;
  readonly clock: () => string;
  readonly signalFor?: (execution: ToolExecutionContext) => AbortSignal | undefined;
};

const withinRadius = (
  shop: HotPepperShopWire,
  context: HarnessContext,
  meters: number,
): boolean => {
  const origin = context.location.coordinates;
  if (origin === null || shop.lat === null || shop.lng === null) return false;
  const radians = Math.PI / 180;
  const a =
    Math.sin(((shop.lat - origin.lat) * radians) / 2) ** 2 +
    Math.cos(origin.lat * radians) *
      Math.cos(shop.lat * radians) *
      Math.sin(((shop.lng - origin.lng) * radians) / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, a))) <= meters;
};

const requestFor = (
  binding: PlacesSearchCursorBinding,
  context: HarnessContext,
  start: number,
): HotPepperSearchRequest => {
  const { area } = binding;
  if (area.kind === 'named_area') {
    return { keyword: `${binding.query} ${area.name}`, count: binding.limit, start };
  }
  const coordinates = context.location.coordinates;
  if (context.location.status !== 'available' || coordinates === null)
    throw new HotPepperError('INVALID_REQUEST');
  const range =
    area.radiusMeters <= 300
      ? 1
      : area.radiusMeters <= 500
        ? 2
        : area.radiusMeters <= 1_000
          ? 3
          : area.radiusMeters <= 2_000
            ? 4
            : 5;
  return { keyword: binding.query, ...coordinates, range, count: binding.limit, start };
};

export const createHotPepperSearchAdapter = (options: SearchOptions): PlaceSearchPort => ({
  async search(input, context, execution, cancellation) {
    const parsed = v.safeParse(SearchPlacesInputSchema, input);
    if (!parsed.success)
      return {
        status: 'error',
        error: hotPepperIssue('INVALID_ARGUMENT', null, 'Invalid search input'),
      };
    if (
      execution.operation !== 'search_places' ||
      execution.threadId !== context.threadId ||
      execution.turnId !== context.turnId ||
      execution.revision !== context.revision
    ) {
      return {
        status: 'error',
        error: hotPepperIssue('STALE_TURN', null, 'Search context changed'),
      };
    }
    try {
      if (cancellation.isCancelled()) throw new HotPepperError('CANCELLED');
      let binding: PlacesSearchCursorBinding;
      let start = 1;
      if (parsed.output.mode === 'continue') {
        const cursor = await options.continuation.resolve(parsed.output.cursor);
        if (!cursor.ok)
          return {
            status: 'error',
            error: hotPepperIssue(
              cursor.code === 'CURSOR_EXPIRED' ? 'CURSOR_EXPIRED' : 'INVALID_ARGUMENT',
              'cursor',
              'Search cursor is invalid or expired',
            ),
          };
        binding = cursor.binding;
        if (
          binding.ownerScopeRef !== context.ownerScopeRef ||
          binding.threadId !== context.threadId ||
          binding.locationRevision !== context.location.revision ||
          !/^hotpepper:[1-9]\d*$/u.test(cursor.providerPageToken)
        ) {
          return {
            status: 'error',
            error: hotPepperIssue(
              'INVALID_ARGUMENT',
              'cursor',
              'Search cursor belongs to another context',
            ),
          };
        }
        start = Number(cursor.providerPageToken.slice('hotpepper:'.length));
      } else {
        const { query, area, openNow, limit, excludeCandidateIds } = parsed.output;
        binding = {
          query,
          area,
          openNow,
          limit,
          excludeCandidateIds,
          ownerScopeRef: context.ownerScopeRef,
          threadId: context.threadId,
          locationRevision: context.location.revision,
        };
      }
      if (binding.openNow)
        return {
          status: 'error',
          error: hotPepperIssue(
            'UNSUPPORTED_FIELD',
            'openNow',
            'Hot Pepper cannot filter open-now; use openNow=false and report opening status as unknown',
          ),
        };
      if (
        binding.area.kind === 'current_location' &&
        (context.location.status !== 'available' || context.location.coordinates === null)
      ) {
        return {
          status: 'error',
          error: hotPepperIssue(
            'LOCATION_REQUIRED',
            'area',
            'Current location is unavailable; use a named area',
          ),
        };
      }
      const page = await options.transport.search(
        requestFor(binding, context, start),
        options.signalFor?.(execution),
      );
      if (cancellation.isCancelled()) throw new HotPepperError('CANCELLED');
      const candidates: unknown[] = [];
      const seen = new Set<string>();
      let excludedCount = 0;
      const area = binding.area.kind === 'named_area' ? binding.area.name : '現在地周辺';
      for (const shop of page.shops) {
        if (seen.has(shop.id)) continue;
        seen.add(shop.id);
        if (
          binding.area.kind === 'current_location' &&
          !withinRadius(shop, context, binding.area.radiusMeters)
        )
          continue;
        const candidate = options.registration.registerCandidate({
          ownerScopeRef: context.ownerScopeRef,
          threadId: context.threadId,
          provider: 'hotpepper',
          recordRef: shop.id,
          displayName: shop.name,
          status: 'unknown',
        });
        if (candidate === undefined) throw new HotPepperError('SCHEMA_MISMATCH');
        if (candidate.excluded || binding.excludeCandidateIds.includes(candidate.candidateId)) {
          excludedCount += 1;
          continue;
        }
        const field = (field: 'identity' | 'opening_hours' | 'price') =>
          registerHotPepperField({
            shop,
            field,
            candidateId: candidate.candidateId,
            context,
            area,
            now: options.clock(),
            registration: options.registration,
          });
        candidates.push({
          candidateId: candidate.candidateId,
          identity: field('identity'),
          openingHours: field('opening_hours'),
          price: field('price'),
        });
        if (candidates.length === binding.limit) break;
      }
      const nextStart = start + page.shops.length;
      const nextCursor =
        page.shops.length > 0 &&
        page.resultsAvailable !== null &&
        nextStart <= page.resultsAvailable
          ? await options.continuation.issue({
              ...binding,
              providerPageToken: `hotpepper:${nextStart}`,
            })
          : null;
      if (cancellation.isCancelled()) throw new HotPepperError('CANCELLED');
      const data = v.parse(SearchPlacesOutputSchema, {
        searchId: options.nextSearchId(),
        candidates,
        applied: { areaDescription: area, openNow: false, excludedCount },
        nextCursor,
        coverage: 'provider_results',
      });
      const warnings = data.candidates.flatMap((candidate) =>
        [candidate.identity, candidate.openingHours, candidate.price].flatMap((field) =>
          field.status === 'error' ? [field.error] : [],
        ),
      );
      return { status: warnings.length ? 'partial' : 'ok', data, warnings };
    } catch (error) {
      return { status: 'error', error: hotPepperProviderIssue(error) };
    }
  },
});
