import {
  GetPlaceDetailsInputSchema,
  HarnessContextSchema,
  ToolExecutionContextSchema,
} from '@ima/core';
import type {
  CapabilitySnapshot,
  CandidateObservationRegistryPort,
  CancellationToken,
  DetailField,
  GetPlaceDetailsInput,
  GetPlaceDetailsOutput,
  HarnessContext,
  Issue,
  PlaceDetailsPort,
  Result,
  ToolExecutionContext,
} from '@ima/core';
import * as v from 'valibot';
import type {
  LastTrainObservationPolicy,
  LastTrainObservationRegistrar,
} from '@worker/infrastructure/adapters/outbound/providers/last-train/registration';
import { createLastTrainObservationRegistrar } from '@worker/infrastructure/adapters/outbound/providers/last-train/registration';
import {
  createLastTrainDetailsPort,
  type LastTrainDetailsDispatcherOptions,
} from '@worker/infrastructure/adapters/outbound/providers/last-train/details-adapter';
import {
  createLastTrainJourneyPort,
  type RuntimeJourneyDataset,
  type LastTrainJourneyPortOptions,
  type LastTrainRoutePorts,
} from '@worker/infrastructure/adapters/outbound/providers/last-train/journey-adapter';
import {
  createPhotoTokenPreparer,
  type PhotoTokenPreparerDependencies,
} from '@worker/infrastructure/runtime/response/photo-token-issuance';
import type { RuntimePhotoTokenPreparer } from '@worker/infrastructure/runtime/response/runtime-response';

/** Kept at this runtime export for callers while the protocol type lives with last-train ports. */
export type { RuntimeJourneyDataset } from '@worker/infrastructure/adapters/outbound/providers/last-train/journey-adapter';

export type RuntimeLastTrainRevisionState = {
  readonly byCandidate: Map<string, { readonly revision: number; readonly evaluationKey: string }>;
};

export const createRuntimeLastTrainRevisionState = (): RuntimeLastTrainRevisionState => ({
  byCandidate: new Map(),
});

export type RuntimeLastTrainCompositionOptions = Omit<
  LastTrainJourneyPortOptions,
  'reader' | 'routes'
> & {
  readonly activeRevision: number | null;
  readonly dataset: RuntimeJourneyDataset;
  readonly routes: LastTrainRoutePorts;
  readonly observationPolicy: LastTrainObservationPolicy;
  readonly fromStationRefFor: LastTrainDetailsDispatcherOptions['fromStationRefFor'];
  /** Creates a child operation and binds it to the host's attempt-signal bridge. */
  readonly executionForLastTrain: LastTrainDetailsDispatcherOptions['executionForLastTrain'];
  readonly registry: CandidateObservationRegistryPort;
  readonly revisionState: RuntimeLastTrainRevisionState;
};

export type RuntimeProviderCompositionOptions = {
  readonly baseDetails: PlaceDetailsPort;
  readonly registry: CandidateObservationRegistryPort;
  readonly clock: () => string;
  readonly lastTrain?: RuntimeLastTrainCompositionOptions;
  readonly photos?: PhotoTokenPreparerDependencies;
};

export type RuntimeProviderComposition = {
  readonly details: PlaceDetailsPort;
  readonly lastTrainEnabled: boolean;
  readonly photosEnabled: boolean;
  readonly preparePhotoTokens?: RuntimePhotoTokenPreparer;
  /** Derives capabilities from actual configured providers; absent providers are removed. */
  readonly capabilitiesFor: (base: CapabilitySnapshot) => CapabilitySnapshot;
};

const issue = (code: Issue['code'], path: string, message: string): Issue => ({
  code,
  path,
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [],
});

const resultError = <T>(error: Issue): Result<T> => ({ status: 'error', error });

const revisionValue = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
};

/** A malformed or unavailable RPC result is distinct from an empty active dataset. */
export const readActiveJourneyRevision = async (
  dataset: Pick<RuntimeJourneyDataset, 'readRevision'>,
): Promise<number | null | undefined> => {
  try {
    return revisionValue(await dataset.readRevision());
  } catch {
    return undefined;
  }
};

const lastTrainCandidateIds = (input: GetPlaceDetailsInput): readonly string[] =>
  input.requests
    .filter((request) => request.fields.includes('last_train'))
    .map((request) => request.candidateId);

const guardedDetails = (options: {
  readonly inner: PlaceDetailsPort;
  readonly registry: CandidateObservationRegistryPort;
  readonly dataset: RuntimeJourneyDataset;
  readonly revisionState: RuntimeLastTrainRevisionState;
  readonly clock: () => string;
  readonly fromStationRefFor: LastTrainDetailsDispatcherOptions['fromStationRefFor'];
}): PlaceDetailsPort => ({
  async read(
    input: GetPlaceDetailsInput,
    context: HarnessContext,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<Result<GetPlaceDetailsOutput>> {
    const parsedInput = v.safeParse(GetPlaceDetailsInputSchema, input);
    const parsedContext = v.safeParse(HarnessContextSchema, context);
    const parsedExecution = v.safeParse(ToolExecutionContextSchema, execution);
    if (
      !parsedInput.success ||
      !parsedContext.success ||
      !parsedExecution.success ||
      parsedExecution.output.operation !== 'get_place_details' ||
      parsedExecution.output.threadId !== parsedContext.output.threadId ||
      parsedExecution.output.turnId !== parsedContext.output.turnId ||
      parsedExecution.output.revision !== parsedContext.output.revision
    ) {
      return options.inner.read(input, context, execution, cancellation);
    }
    const candidateIds = lastTrainCandidateIds(parsedInput.output);
    if (candidateIds.length === 0)
      return options.inner.read(parsedInput.output, parsedContext.output, execution, cancellation);

    if (cancellation.isCancelled()) {
      return options.inner.read(parsedInput.output, parsedContext.output, execution, cancellation);
    }

    const revision = await readActiveJourneyRevision(options.dataset);
    const evaluationClock = (() => {
      try {
        return options.clock();
      } catch {
        return undefined;
      }
    })();
    const evaluationKeys = new Map<string, string | undefined>();
    for (const candidateId of candidateIds) {
      let stationRef: string | undefined;
      try {
        const candidate = options.registry.readCandidate(
          {
            ownerScopeRef: parsedContext.output.ownerScopeRef,
            threadId: parsedContext.output.threadId,
          },
          candidateId,
        );
        if (candidate !== undefined)
          stationRef = options.fromStationRefFor(candidate, parsedContext.output);
      } catch {
        stationRef = undefined;
      }
      const travelContext = parsedInput.output.travelContext;
      evaluationKeys.set(
        candidateId,
        evaluationClock === undefined || stationRef === undefined
          ? undefined
          : [
              parsedContext.output.serverNow,
              evaluationClock,
              stationRef,
              travelContext?.homeStationRef ?? parsedContext.output.preferences.homeStationRef,
              String(
                travelContext?.minimumStayMinutes ??
                  parsedContext.output.preferences.minimumStayMinutes,
              ),
            ].join('\u0000'),
      );
    }
    const mustBlockReuse = parsedInput.output.freshness === 'reuse_valid';
    if (mustBlockReuse) {
      if (cancellation.isCancelled())
        return options.inner.read(
          parsedInput.output,
          parsedContext.output,
          execution,
          cancellation,
        );
      try {
        for (const candidateId of candidateIds) {
          const evaluationKey = evaluationKeys.get(candidateId);
          const previous = options.revisionState.byCandidate.get(candidateId);
          if (
            revision === undefined ||
            evaluationKey === undefined ||
            previous === undefined ||
            revision !== previous.revision ||
            evaluationKey !== previous.evaluationKey
          ) {
            options.registry.invalidateObservationReuse(
              {
                ownerScopeRef: parsedContext.output.ownerScopeRef,
                threadId: parsedContext.output.threadId,
              },
              candidateId,
              'last_train',
            );
          }
        }
      } catch {
        return resultError(
          issue('MISSING_CONTEXT', 'last_train', 'last-train observation registry is unavailable'),
        );
      }
    }

    const result = await options.inner.read(
      parsedInput.output,
      parsedContext.output,
      execution,
      cancellation,
    );
    if (revision !== undefined && revision !== null) {
      for (const candidateId of candidateIds) {
        const evaluationKey = evaluationKeys.get(candidateId);
        if (evaluationKey !== undefined) {
          options.revisionState.byCandidate.set(candidateId, { revision, evaluationKey });
        }
      }
    }
    return result;
  },
});

const capabilitiesFor = (
  base: CapabilitySnapshot,
  lastTrainEnabled: boolean,
  photosEnabled: boolean,
): CapabilitySnapshot => {
  const detailFields: DetailField[] = base.detailFields.filter(
    (field) => field !== 'last_train' && field !== 'photos',
  );
  if (photosEnabled) detailFields.push('photos');
  if (lastTrainEnabled) detailFields.push('last_train');
  return {
    ...base,
    detailFields,
    lastTrain: lastTrainEnabled,
  };
};

const createLastTrainDetails = (
  options: RuntimeLastTrainCompositionOptions,
  baseDetails: PlaceDetailsPort,
  clock: () => string,
): PlaceDetailsPort => {
  const journey = createLastTrainJourneyPort({
    reader: options.dataset,
    routes: options.routes,
    buildServiceDateContext: options.buildServiceDateContext,
    clock: options.clock,
    currentOriginRef: options.currentOriginRef,
    routeExecutionFor: options.routeExecutionFor,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const registrar: LastTrainObservationRegistrar = createLastTrainObservationRegistrar({
    registry: options.registry,
    clock: { now: clock },
    currentOriginRef: options.currentOriginRef,
    observationPolicy: options.observationPolicy,
  });
  const details = createLastTrainDetailsPort({
    base: baseDetails,
    journey,
    registry: options.registry,
    registrar,
    fromStationRefFor: options.fromStationRefFor,
    executionForLastTrain: options.executionForLastTrain,
  });
  return guardedDetails({
    inner: details,
    registry: options.registry,
    dataset: options.dataset,
    revisionState: options.revisionState,
    clock,
    fromStationRefFor: options.fromStationRefFor,
  });
};

/**
 * Wires M14 and M15 into the per-turn provider plan without inventing stations or photo data.
 * The factory must pass a non-null activeRevision only after probing the named dataset DO.
 */
export const createRuntimeProviderComposition = (
  options: RuntimeProviderCompositionOptions,
): RuntimeProviderComposition => {
  const lastTrainEnabled =
    options.lastTrain !== undefined && options.lastTrain.activeRevision !== null;
  const details = lastTrainEnabled
    ? createLastTrainDetails(options.lastTrain, options.baseDetails, options.clock)
    : options.baseDetails;
  const photosEnabled =
    options.photos !== undefined &&
    options.photos.photosEnabled &&
    options.photos.deviceId.length > 0;
  const preparePhotoTokens = photosEnabled ? createPhotoTokenPreparer(options.photos) : undefined;
  return {
    details,
    lastTrainEnabled,
    photosEnabled,
    ...(preparePhotoTokens === undefined ? {} : { preparePhotoTokens }),
    capabilitiesFor: (base) => capabilitiesFor(base, lastTrainEnabled, photosEnabled),
  };
};
