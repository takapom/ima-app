import * as v from 'valibot';
import {
  GetPlaceDetailsInputSchema,
  GetPlaceDetailsOutputSchema,
  type PlaceDetailsPort,
} from '@worker/application/ports/operations';
import { type CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import { type ToolExecutionContext } from '@worker/application/ports/context';
import type { PlacesSearchRegistration } from '@worker/adapters/out/providers/places-search/registration';
import type { HotPepperTransport } from '@worker/adapters/out/providers/hot-pepper/transport';
import { HotPepperError } from '@worker/adapters/out/providers/hot-pepper/types';
import {
  hotPepperIssue,
  hotPepperProviderIssue,
  hotPepperObservationContext,
  isHotPepperDetailField,
  registerHotPepperField,
} from '@worker/adapters/out/providers/hot-pepper/place-observations';

export const createHotPepperDetailsAdapter = (options: {
  readonly transport: HotPepperTransport;
  readonly registry: CandidateObservationRegistryPort;
  readonly registration: PlacesSearchRegistration;
  readonly clock: () => string;
  readonly areaFor: (candidateId: string) => string;
  readonly signalFor?: (execution: ToolExecutionContext) => AbortSignal | undefined;
}): PlaceDetailsPort => ({
  async read(input, context, execution, cancellation) {
    const parsed = v.safeParse(GetPlaceDetailsInputSchema, input);
    if (!parsed.success)
      return {
        status: 'error',
        error: hotPepperIssue('INVALID_ARGUMENT', null, 'Invalid details input'),
      };
    if (
      execution.threadId !== context.threadId ||
      execution.turnId !== context.turnId ||
      execution.revision !== context.revision ||
      execution.operation !== 'get_place_details'
    ) {
      return {
        status: 'error',
        error: hotPepperIssue('STALE_TURN', null, 'Details context changed'),
      };
    }
    const scope = { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId };
    const items: { candidateId: string; fields: Record<string, unknown> }[] = [];
    for (const request of parsed.output.requests) {
      if (cancellation.isCancelled())
        return { status: 'error', error: hotPepperProviderIssue(new HotPepperError('CANCELLED')) };
      const fields: Record<string, unknown> = {};
      const candidate = options.registry.readCandidate(scope, request.candidateId);
      const missing: typeof request.fields = [];
      for (const field of request.fields) {
        if (candidate === undefined || candidate.excluded || candidate.provider !== 'hotpepper') {
          fields[field] = {
            status: 'error',
            error: hotPepperIssue('UNKNOWN_CANDIDATE', field, 'Candidate is unavailable'),
          };
        } else if (!isHotPepperDetailField(field)) {
          fields[field] = {
            status: 'unsupported',
            reason: 'Hot Pepper does not supply this field',
          };
        } else {
          const reused =
            input.freshness === 'reuse_valid'
              ? options.registry.evaluateObservationReuse({
                  scope,
                  candidateId: candidate.candidateId,
                  field,
                  context: hotPepperObservationContext(context),
                })
              : undefined;
          if (reused?.status === 'reusable')
            fields[field] = { status: 'known', observations: [reused.observation] };
          else missing.push(field);
        }
      }
      if (candidate !== undefined && missing.length > 0) {
        try {
          for (const field of missing)
            options.registry.invalidateObservationReuse(scope, candidate.candidateId, field);
          const page = await options.transport.search(
            { id: [candidate.recordRef], count: 1 },
            options.signalFor?.(execution),
          );
          if (cancellation.isCancelled()) throw new HotPepperError('CANCELLED');
          const shop = page.shops.find((shop) => shop.id === candidate.recordRef);
          if (shop === undefined)
            throw new HotPepperError(page.shops.length ? 'SOURCE_CONFLICT' : 'NOT_FOUND');
          for (const field of missing) {
            if (isHotPepperDetailField(field))
              fields[field] = registerHotPepperField({
                shop,
                field,
                candidateId: candidate.candidateId,
                context,
                now: options.clock(),
                area: options.areaFor(candidate.candidateId),
                registration: options.registration,
              });
          }
        } catch (error) {
          for (const field of missing)
            fields[field] = { status: 'error', error: hotPepperProviderIssue(error) };
        }
      }
      items.push({ candidateId: request.candidateId, fields });
    }
    const output = v.safeParse(GetPlaceDetailsOutputSchema, { items });
    if (!output.success)
      return {
        status: 'error',
        error: hotPepperIssue('SCHEMA_MISMATCH', null, 'Invalid details result'),
      };
    const warnings = output.output.items.flatMap((item) =>
      Object.values(item.fields).flatMap((field) =>
        field?.status === 'error' ? [field.error] : [],
      ),
    );
    return { status: warnings.length ? 'partial' : 'ok', data: output.output, warnings };
  },
});
