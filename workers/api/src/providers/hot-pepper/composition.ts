import * as v from 'valibot';
import {
  FacilitiesInfoSchema,
  GetPlaceDetailsInputSchema,
  GetPlaceDetailsOutputSchema,
  IsoTimestampSchema,
  ObservationSchema,
  PriceInfoSchema,
  type CandidateObservationRegistryPort,
  type CandidateRecord,
  type CancellationToken,
  type ClockPort,
  type GetPlaceDetailsInput,
  type GetPlaceDetailsOutput,
  type HarnessContext,
  type PlaceDetailsPort,
  type Result,
  type ToolExecutionContext,
} from '@ima/core';
import { outputResult } from '../places-details/adapter-result';
import { observationContextFor } from '../places-details/adapter-support';
import type { PlacesDetailsObservationPolicy } from '../places-details/adapter-types';
import type { HotPepperAdapter } from './adapter';
import type {
  HotPepperCandidateReference,
  HotPepperFieldPolicy,
  HotPepperPriceSupplement,
  HotPepperProviderInputPolicy,
  HotPepperSupplement,
} from './types';
import type { HotPepperTransport } from './transport';
import {
  hotPepperFieldAllowed,
  isKnown,
  reprojectHotPepperField,
  retentionFor,
  type HotPepperOverlayField,
} from './policy-projection';

/** The Host supplies candidate coordinates only after the separate input gate has passed. */
export type HotPepperCandidateReferenceFor = (
  candidate: Readonly<CandidateRecord>,
  context: HarnessContext,
) => HotPepperCandidateReference | undefined;

export type RuntimeProductionHotPepperConfiguration = {
  /** Explicit capability gate; an operational flag alone never sends a candidate to HP. */
  readonly hotPepperEnabled?: boolean;
  readonly hotPepperApiKey?: string;
  readonly hotPepperFetcher?: typeof fetch;
  readonly hotPepperTransport?: HotPepperTransport;
  readonly hotPepperFieldPolicy?: HotPepperFieldPolicy;
  readonly hotPepperProviderInputPolicy?: HotPepperProviderInputPolicy;
  /** HP observation expiry/retention is separate from the Google Places policy. */
  readonly hotPepperObservationPolicy?: PlacesDetailsObservationPolicy;
  readonly hotPepperCandidateReferenceFor?: HotPepperCandidateReferenceFor;
};

export type HotPepperDetailsOverlayOptions = {
  readonly inner: PlaceDetailsPort;
  readonly adapter: HotPepperAdapter;
  readonly registry: CandidateObservationRegistryPort;
  readonly clock: ClockPort;
  readonly observationPolicy: PlacesDetailsObservationPolicy;
  /** The HP policy remains the owner of llm_input/display/persistence decisions. */
  readonly fieldPolicy: HotPepperFieldPolicy;
  readonly candidateReferenceFor: HotPepperCandidateReferenceFor;
  /** The enclosing read must admit each additional HP request before transport starts. */
  readonly reserveProviderRequest: () => boolean;
  readonly signalFor?: (execution: ToolExecutionContext) => AbortSignal | undefined;
};

type DetailsItem = GetPlaceDetailsOutput['items'][number];

const overlayFields: readonly HotPepperOverlayField[] = ['facilities', 'price'];

const sourceFor = (supplement: HotPepperSupplement) => [
  {
    provider: supplement.source.provider,
    recordRef: supplement.source.recordRef,
    attribution: supplement.source.attribution,
    publicUrl: supplement.source.publicUrl,
  },
];

const valueForPrice = (
  value: HotPepperPriceSupplement,
): v.InferOutput<typeof PriceInfoSchema> | undefined => {
  const labels = [value.budgetLabel, value.averageLabel].filter(
    (label): label is string => label !== null,
  );
  if (labels.length === 0) return undefined;
  const rawLabel = labels.join(' / ');
  return rawLabel.length <= 160 ? { level: null, range: null, rawLabel } : undefined;
};

const fieldValueFor = (
  field: HotPepperOverlayField,
  supplement: HotPepperSupplement,
):
  | v.InferOutput<typeof FacilitiesInfoSchema>
  | v.InferOutput<typeof PriceInfoSchema>
  | undefined => {
  if (field === 'facilities') {
    return supplement.facilities.status === 'known'
      ? { ...supplement.facilities.value, sourceText: [...supplement.facilities.value.sourceText] }
      : undefined;
  }
  return supplement.price.status === 'known' ? valueForPrice(supplement.price.value) : undefined;
};

const reusableFieldFor = (
  options: HotPepperDetailsOverlayOptions,
  context: HarnessContext,
  candidateId: string,
  field: HotPepperOverlayField,
): unknown => {
  try {
    const reuse = options.registry.evaluateObservationReuse({
      scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      candidateId,
      field,
      context: observationContextFor(context),
    });
    if (reuse.status !== 'reusable') return undefined;
    if (
      reuse.observation.sources.length === 0 ||
      !reuse.observation.sources.every((source) => source.provider === 'hotpepper')
    ) {
      return undefined;
    }
    if (!hotPepperFieldAllowed(options.fieldPolicy, options.adapter.mode, field)) return undefined;
    const schema = field === 'facilities' ? FacilitiesInfoSchema : PriceInfoSchema;
    const retention = retentionFor(
      options.fieldPolicy,
      options.adapter.mode,
      field,
      reuse.observation.retention,
    );
    if (retention === undefined) return undefined;
    const parsed = v.safeParse(ObservationSchema(schema), {
      ...reuse.observation,
      retention,
    });
    return parsed.success ? { status: 'known', observations: [parsed.output] } : undefined;
  } catch {
    return undefined;
  }
};

const registerField = (
  options: HotPepperDetailsOverlayOptions,
  context: HarnessContext,
  candidateId: string,
  field: HotPepperOverlayField,
  value: unknown,
  supplement: HotPepperSupplement,
): unknown => {
  const parsedValue = v.safeParse(
    field === 'facilities' ? FacilitiesInfoSchema : PriceInfoSchema,
    value,
  );
  if (!parsedValue.success) return undefined;
  if (!hotPepperFieldAllowed(options.fieldPolicy, options.adapter.mode, field)) return undefined;
  let now: string;
  try {
    now = options.clock.now();
  } catch {
    return undefined;
  }
  if (!v.safeParse(IsoTimestampSchema, now).success) {
    return undefined;
  }
  const observation = {
    scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
    candidateId,
    field,
    value: parsedValue.output,
    basis: 'provider_reported' as const,
    sourceUpdatedAt: null,
    context: observationContextFor(context),
    sources: sourceFor(supplement),
  };
  let policy: ReturnType<PlacesDetailsObservationPolicy> | undefined;
  try {
    policy = options.observationPolicy({ now, observation });
  } catch {
    return undefined;
  }
  if (policy === undefined) return undefined;
  const retention = retentionFor(
    options.fieldPolicy,
    options.adapter.mode,
    field,
    policy.retention,
  );
  if (retention === undefined) return undefined;
  try {
    const stored = options.registry.registerObservation({ ...observation, ...policy, retention });
    if (
      !options.registry.restoreObservationReuse(
        { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
        candidateId,
        field,
        [stored.observationId],
      )
    ) {
      return undefined;
    }
    const schema = field === 'facilities' ? FacilitiesInfoSchema : PriceInfoSchema;
    const parsed = v.safeParse(ObservationSchema(schema), stored);
    return parsed.success ? { status: 'known', observations: [parsed.output] } : undefined;
  } catch {
    return undefined;
  }
};

const overlayItem = async (
  options: HotPepperDetailsOverlayOptions,
  request: GetPlaceDetailsInput['requests'][number],
  freshness: GetPlaceDetailsInput['freshness'],
  item: DetailsItem,
  context: HarnessContext,
  execution: ToolExecutionContext,
  cancellation: CancellationToken,
): Promise<DetailsItem> => {
  let candidate: Readonly<CandidateRecord> | undefined;
  try {
    candidate = options.registry.readCandidate(
      { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      request.candidateId,
    );
  } catch {
    return item;
  }
  if (candidate === undefined || candidate.excluded) return item;
  const requested = overlayFields.filter((field) => request.fields.includes(field));
  if (requested.length === 0) return item;
  const fields: Record<string, unknown> = { ...item.fields };
  for (const field of overlayFields) {
    fields[field] = reprojectHotPepperField(
      options.fieldPolicy,
      options.adapter.mode,
      field,
      fields[field],
    );
  }
  const projectedItem = (): DetailsItem => ({ candidateId: item.candidateId, fields });
  const missing = requested.filter((field) => !isKnown(fields[field]));
  if (missing.length === 0) return { candidateId: item.candidateId, fields };

  if (cancellation.isCancelled()) return projectedItem();
  let signal: AbortSignal | undefined;
  try {
    signal = options.signalFor?.(execution);
  } catch {
    return projectedItem();
  }
  const signalIsAborted = (): boolean => signal?.aborted === true;
  if (signalIsAborted()) return projectedItem();

  if (request.fields.includes('facilities') || request.fields.includes('price')) {
    for (const field of missing) {
      if (freshness !== 'refresh') {
        const reused = reusableFieldFor(options, context, request.candidateId, field);
        if (reused !== undefined) fields[field] = reused;
      }
    }
  }
  const stillMissing = missing.filter((field) => !isKnown(fields[field]));
  if (stillMissing.length === 0 || cancellation.isCancelled() || signalIsAborted()) {
    return { candidateId: item.candidateId, fields };
  }
  const allowedFields = stillMissing.filter((field) =>
    hotPepperFieldAllowed(options.fieldPolicy, options.adapter.mode, field),
  );
  if (allowedFields.length === 0) return { candidateId: item.candidateId, fields };
  if (freshness === 'refresh') {
    for (const field of allowedFields) {
      try {
        options.registry.invalidateObservationReuse(
          { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
          request.candidateId,
          field,
        );
      } catch {
        return { candidateId: item.candidateId, fields };
      }
    }
  }

  let reference: HotPepperCandidateReference | undefined;
  try {
    reference = options.candidateReferenceFor(candidate, context);
  } catch {
    return { candidateId: item.candidateId, fields };
  }
  if (reference === undefined || reference.candidateId !== request.candidateId) {
    return { candidateId: item.candidateId, fields };
  }
  let reserved = false;
  try {
    reserved = options.reserveProviderRequest();
  } catch {
    return { candidateId: item.candidateId, fields };
  }
  if (!reserved) return { candidateId: item.candidateId, fields };
  let supplement;
  try {
    supplement = await options.adapter.read(reference, 'llm_input', signal);
  } catch {
    return { candidateId: item.candidateId, fields };
  }
  if (supplement.status !== 'ok' || cancellation.isCancelled() || signalIsAborted()) {
    return projectedItem();
  }
  if (supplement.value.candidateId !== request.candidateId) {
    return { candidateId: item.candidateId, fields };
  }
  let currentCandidate: Readonly<CandidateRecord> | undefined;
  try {
    currentCandidate = options.registry.readCandidate(
      { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      request.candidateId,
    );
  } catch {
    return { candidateId: item.candidateId, fields };
  }
  if (currentCandidate === undefined || currentCandidate.excluded) {
    return { candidateId: item.candidateId, fields };
  }
  for (const field of allowedFields) {
    const value = fieldValueFor(field, supplement.value);
    if (value === undefined) continue;
    const registered = registerField(
      options,
      context,
      request.candidateId,
      field,
      value,
      supplement.value,
    );
    if (registered !== undefined) fields[field] = registered;
  }
  return { candidateId: item.candidateId, fields };
};

/** Removes HP observations from a Google-only graph when the optional adapter is unavailable. */
export const createHotPepperReuseFilter = (
  inner: PlaceDetailsPort,
  fieldPolicy: HotPepperFieldPolicy,
  mode: HotPepperAdapter['mode'],
): PlaceDetailsPort => ({
  async read(input, context, execution, cancellation): Promise<Result<GetPlaceDetailsOutput>> {
    const base = await inner.read(input, context, execution, cancellation);
    if (base.status === 'error') return base;
    const items = base.data.items.map((item) => {
      const fields: Record<string, unknown> = { ...item.fields };
      for (const field of overlayFields) {
        fields[field] = reprojectHotPepperField(fieldPolicy, mode, field, fields[field]);
      }
      return { candidateId: item.candidateId, fields };
    });
    return outputResult(items);
  },
});

/** Adds optional HP facts while preserving the Core Details result and its failure semantics. */
export const createHotPepperDetailsOverlay = (
  options: HotPepperDetailsOverlayOptions,
): PlaceDetailsPort => ({
  async read(input, context, execution, cancellation): Promise<Result<GetPlaceDetailsOutput>> {
    const base = await options.inner.read(input, context, execution, cancellation);
    if (base.status === 'error') return base;
    const parsedInput = v.safeParse(GetPlaceDetailsInputSchema, input);
    const parsedOutput = v.safeParse(GetPlaceDetailsOutputSchema, base.data);
    if (!parsedInput.success || !parsedOutput.success || cancellation.isCancelled()) return base;
    const byCandidate = new Map(parsedOutput.output.items.map((item) => [item.candidateId, item]));
    const nextItems: DetailsItem[] = [];
    for (const request of parsedInput.output.requests) {
      const item = byCandidate.get(request.candidateId);
      if (item === undefined) return base;
      nextItems.push(
        await overlayItem(
          options,
          request,
          parsedInput.output.freshness,
          item,
          context,
          execution,
          cancellation,
        ),
      );
    }
    return outputResult(nextItems);
  },
});
