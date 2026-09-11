import * as v from 'valibot';
import { IsoTimestampSchema, ObservationSchema, OpeningHoursSchema } from '@ima/core';
import type {
  CandidateObservationRegistryPort,
  CancellationToken,
  ClockPort,
  GetPlaceDetailsInput,
  HarnessContext,
  Issue,
  PlaceDetailsPort,
  ToolExecutionContext,
} from '@ima/core';
import { issue, observationContextFor } from '../places-details/adapter-support';
import type { PlacesDetailsObservationPolicy } from '../places-details/adapter-types';
import {
  intersectHotPepperOpeningRetention,
  mergeHotPepperOpeningHours,
  mergeHotPepperOpeningSources,
  type OpeningHoursObservation,
} from './opening-hours';
import { hotPepperFieldAllowed, retentionFor } from './policy-projection';
import type { HotPepperFieldPolicy, HotPepperRuntimeMode, HotPepperSupplement } from './types';

export type HotPepperOpeningHoursRegistrationOptions = {
  readonly registry: Pick<CandidateObservationRegistryPort, 'replaceObservation'>;
  readonly clock: ClockPort;
  readonly observationPolicy: PlacesDetailsObservationPolicy;
  readonly fieldPolicy: HotPepperFieldPolicy;
  readonly mode: HotPepperRuntimeMode;
};

export type HotPepperOpeningHoursRegistrationResult =
  | { readonly status: 'registered'; readonly value: unknown }
  | { readonly status: 'conflict'; readonly warning: Issue };

const sourceFor = (supplement: HotPepperSupplement) =>
  [
    {
      provider: supplement.source.provider,
      recordRef: supplement.source.recordRef,
      attribution: supplement.source.attribution,
      publicUrl: supplement.source.publicUrl,
    },
  ] as const;

const openingObservationFor = (value: unknown): OpeningHoursObservation | undefined => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('status' in value) ||
    value.status !== 'known' ||
    !('observations' in value) ||
    !Array.isArray(value.observations)
  ) {
    return undefined;
  }
  const parsed = v.safeParse(ObservationSchema(OpeningHoursSchema), value.observations[0]);
  return parsed.success ? parsed.output : undefined;
};

const sourcesAreGoogleOrHotPepper = (sources: readonly { readonly provider: string }[]): boolean =>
  sources.length > 0 &&
  sources.some((source) => source.provider === 'google_places') &&
  sources.every((source) => source.provider === 'google_places' || source.provider === 'hotpepper');

export const hotPepperOpeningSourcesAreReusable = (
  sources: readonly { readonly provider: string }[],
): boolean =>
  sourcesAreGoogleOrHotPepper(sources) && sources.some((source) => source.provider === 'hotpepper');

const earlierTimestamp = (left: string, right: string): string | undefined => {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return undefined;
  return leftMs <= rightMs ? left : right;
};

export const registerHotPepperOpeningHours = (
  options: HotPepperOpeningHoursRegistrationOptions,
  context: HarnessContext,
  candidateId: string,
  baseValue: unknown,
  supplement: HotPepperSupplement,
): HotPepperOpeningHoursRegistrationResult | undefined => {
  if (supplement.openingHours.status !== 'known') return undefined;
  const base = openingObservationFor(baseValue);
  if (base === undefined || !sourcesAreGoogleOrHotPepper(base.sources)) return undefined;
  if (base.freshUntil === undefined) return undefined;
  const merged = mergeHotPepperOpeningHours(base.value, supplement.openingHours.value);
  if (merged.status === 'conflict') {
    return {
      status: 'conflict',
      warning: issue(
        'SOURCE_CONFLICT',
        'opening_hours',
        'Hot Pepper opening-hours data conflicts with Google data',
      ),
    };
  }
  if (merged.status !== 'merged') return undefined;
  const [hotPepperSource] = sourceFor(supplement);
  const sources = mergeHotPepperOpeningSources(base.sources, hotPepperSource);
  if (sources === undefined) {
    return {
      status: 'conflict',
      warning: issue(
        'SOURCE_CONFLICT',
        'opening_hours',
        'Hot Pepper opening-hours source metadata conflicts with Google data',
      ),
    };
  }
  if (!hotPepperFieldAllowed(options.fieldPolicy, options.mode, 'opening_hours')) {
    return undefined;
  }
  let now: string;
  try {
    now = options.clock.now();
  } catch {
    return undefined;
  }
  if (!v.safeParse(IsoTimestampSchema, now).success) return undefined;
  const observation = {
    scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
    candidateId,
    field: 'opening_hours' as const,
    value: merged.value,
    basis: 'provider_reported' as const,
    sourceUpdatedAt: null,
    context: observationContextFor(context),
    sources,
  };
  let policy: ReturnType<PlacesDetailsObservationPolicy> | undefined;
  try {
    policy = options.observationPolicy({ now, observation });
  } catch {
    return undefined;
  }
  if (policy === undefined) return undefined;
  const hpRetention = retentionFor(
    options.fieldPolicy,
    options.mode,
    'opening_hours',
    policy.retention,
  );
  const retention =
    hpRetention === undefined
      ? undefined
      : intersectHotPepperOpeningRetention(base.retention, hpRetention);
  const freshUntil = earlierTimestamp(base.freshUntil, policy.freshUntil);
  const expiresAt = earlierTimestamp(base.expiresAt, policy.expiresAt);
  if (retention === undefined || freshUntil === undefined || expiresAt === undefined)
    return undefined;
  if (Date.parse(now) >= Date.parse(freshUntil) || Date.parse(now) >= Date.parse(expiresAt)) {
    return undefined;
  }
  try {
    const stored = options.registry.replaceObservation({
      expectedObservationId: base.observationId,
      registration: { ...observation, freshUntil, expiresAt, retention },
    });
    const parsed = v.safeParse(ObservationSchema(OpeningHoursSchema), stored);
    return parsed.success
      ? { status: 'registered', value: { status: 'known', observations: [parsed.output] } }
      : undefined;
  } catch {
    return undefined;
  }
};

export const refreshGoogleOpening = async (
  inner: PlaceDetailsPort,
  candidateId: string,
  context: HarnessContext,
  execution: ToolExecutionContext,
  cancellation: CancellationToken,
  reserveProviderRequest: () => boolean,
): Promise<unknown> => {
  if (cancellation.isCancelled()) return undefined;
  let reserved = false;
  try {
    reserved = reserveProviderRequest();
  } catch {
    return undefined;
  }
  if (!reserved) return undefined;
  const input: GetPlaceDetailsInput = {
    requests: [{ candidateId, fields: ['opening_hours'] }],
    freshness: 'refresh',
  };
  let result: Awaited<ReturnType<PlaceDetailsPort['read']>>;
  try {
    result = await inner.read(input, context, execution, cancellation);
  } catch {
    return undefined;
  }
  if (result.status === 'error' || cancellation.isCancelled()) return undefined;
  const item = result.data.items.find((candidate) => candidate.candidateId === candidateId);
  const opening = item?.fields.opening_hours;
  if (
    opening === undefined ||
    typeof opening !== 'object' ||
    opening === null ||
    !('status' in opening) ||
    opening.status !== 'known' ||
    !('observations' in opening) ||
    !Array.isArray(opening.observations) ||
    opening.observations.length === 0
  ) {
    return undefined;
  }
  const observations = opening.observations.map((observation) =>
    v.safeParse(ObservationSchema(OpeningHoursSchema), observation),
  );
  if (
    observations.some(
      (parsed) =>
        !parsed.success ||
        parsed.output.candidateId !== candidateId ||
        parsed.output.field !== 'opening_hours' ||
        parsed.output.sources.length === 0 ||
        parsed.output.sources.some((source) => source.provider !== 'google_places'),
    )
  ) {
    return undefined;
  }
  return {
    status: 'known',
    observations: observations.map((parsed) => (parsed.success ? parsed.output : undefined)),
  };
};
