import * as v from 'valibot';
import {
  GetPlaceDetailsInputSchema,
  GetPlaceDetailsOutputSchema,
  LastTrainJourneyInputSchema,
  type GetPlaceDetailsInput,
  type GetPlaceDetailsOutput,
  type LastTrainJourneyInput,
  type LastTrainJourneyPort,
  type PlaceDetailsPort,
} from '@worker/application/ports/operations';
import {
  HarnessContextSchema,
  ToolExecutionContextSchema,
  type CancellationToken,
  type HarnessContext,
  type ToolExecutionContext,
} from '@worker/application/ports/context';
import { type CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import { type CandidateRecord } from '@worker/domain/candidates/registry';
import { type FieldResult, type Result } from '@worker/domain/result';
import { type Issue } from '@worker/domain/issue';
import { type LastTrainObservationRegistrar } from '@worker/adapters/out/providers/last-train/registration';

type DetailsRequest = GetPlaceDetailsInput['requests'][number];
type CandidateLookup =
  | { readonly ok: true; readonly candidate: Readonly<CandidateRecord> }
  | { readonly ok: false; readonly field: FieldResult<unknown> };

export type LastTrainDetailsDispatcherOptions = {
  /** Existing detail providers remain responsible for their own fields. */
  readonly base: PlaceDetailsPort;
  readonly journey: LastTrainJourneyPort;
  readonly registry: CandidateObservationRegistryPort;
  readonly registrar: LastTrainObservationRegistrar;
  /** Resolves the candidate's verified station; no station is inferred from free text. */
  readonly fromStationRefFor: (
    candidate: Readonly<CandidateRecord>,
    context: HarnessContext,
  ) => string | undefined;
  /** Binds a details invocation to a Worker-owned last-train execution identity. */
  readonly executionForLastTrain: (execution: ToolExecutionContext) => ToolExecutionContext;
};

const issue = (code: Issue['code'], path: string | null, message: string): Issue => ({
  code,
  path,
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [],
});

const resultError = <T>(error: Issue): Result<T> => ({ status: 'error', error });

const fieldError = <T>(error: Issue): FieldResult<T> => ({ status: 'error', error });

const lastTrainRequests = (input: GetPlaceDetailsInput): readonly DetailsRequest[] =>
  input.requests.filter((request) => request.fields.includes('last_train'));

const baseInputFor = (input: GetPlaceDetailsInput): GetPlaceDetailsInput | undefined => {
  const requests = input.requests.flatMap((request) => {
    const fields = request.fields.filter((field) => field !== 'last_train');
    return fields.length === 0 ? [] : [{ candidateId: request.candidateId, fields }];
  });
  if (requests.length === 0) return undefined;
  return {
    freshness: input.freshness,
    requests,
    ...(input.travelContext === undefined ? {} : { travelContext: input.travelContext }),
  };
};

const candidateFor = (
  options: LastTrainDetailsDispatcherOptions,
  request: DetailsRequest,
  context: HarnessContext,
): CandidateLookup => {
  let candidate: Readonly<CandidateRecord> | undefined;
  try {
    candidate = options.registry.readCandidate(
      { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      request.candidateId,
    );
  } catch {
    return {
      ok: false,
      field: fieldError(
        issue('MISSING_CONTEXT', 'last_train', 'candidate registry is unavailable'),
      ),
    };
  }
  if (candidate === undefined) {
    return {
      ok: false,
      field: fieldError(
        issue('UNKNOWN_CANDIDATE', 'last_train', 'candidate is not owned by this thread'),
      ),
    };
  }
  if (candidate.excluded) {
    return {
      ok: false,
      field: fieldError(issue('EXCLUDED_CANDIDATE', 'last_train', 'candidate is excluded')),
    };
  }
  if (candidate.provider !== 'hotpepper') {
    return {
      ok: false,
      field: fieldError(
        issue('UNSUPPORTED_FIELD', 'last_train', 'candidate provider is unsupported'),
      ),
    };
  }
  return { ok: true, candidate };
};

const journeyInputFor = (
  options: LastTrainDetailsDispatcherOptions,
  request: GetPlaceDetailsInput,
  detailsRequest: DetailsRequest,
  context: HarnessContext,
  candidate: Readonly<CandidateRecord>,
): LastTrainJourneyInput | Issue => {
  let fromStationRef: string | undefined;
  try {
    fromStationRef = options.fromStationRefFor(candidate, context);
  } catch {
    return issue('MISSING_CONTEXT', 'last_train.fromStationRef', 'station resolver is unavailable');
  }
  const homeStationRef =
    request.travelContext?.homeStationRef ?? context.preferences.homeStationRef;
  const minimumStayMinutes =
    request.travelContext?.minimumStayMinutes ?? context.preferences.minimumStayMinutes;
  const parsed = v.safeParse(LastTrainJourneyInputSchema, {
    candidateId: detailsRequest.candidateId,
    fromStationRef,
    homeStationRef,
    departure: 'now',
    minimumStayMinutes,
  });
  return parsed.success
    ? parsed.output
    : issue(
        'MISSING_CONTEXT',
        'last_train',
        'home station, station origin, and minimum stay are required',
      );
};

const warningForField = (field: FieldResult<unknown>): Issue | undefined => {
  if (field.status === 'error') return field.error;
  return undefined;
};

const effectiveTravelContextMatches = (
  input: GetPlaceDetailsInput,
  context: HarnessContext,
): boolean => {
  const requested = input.travelContext;
  if (requested === undefined) return true;
  return (
    (requested.homeStationRef === undefined ||
      requested.homeStationRef === context.preferences.homeStationRef) &&
    (requested.minimumStayMinutes === undefined ||
      requested.minimumStayMinutes === context.preferences.minimumStayMinutes)
  );
};

const lastTrainCapabilityAvailable = (context: HarnessContext): boolean =>
  context.capabilities.lastTrain && context.capabilities.detailFields.includes('last_train');

const readLastTrain = async (
  options: LastTrainDetailsDispatcherOptions,
  input: GetPlaceDetailsInput,
  request: DetailsRequest,
  context: HarnessContext,
  execution: ToolExecutionContext,
  cancellation: CancellationToken,
): Promise<{ readonly field: FieldResult<unknown>; readonly warnings: readonly Issue[] }> => {
  if (!lastTrainCapabilityAvailable(context)) {
    const error = issue('UNSUPPORTED_FIELD', 'last_train', 'last-train capability is disabled');
    return { field: fieldError(error), warnings: [error] };
  }
  if (!effectiveTravelContextMatches(input, context)) {
    const error = issue(
      'CONSTRAINT_VIOLATION',
      'last_train.preferences',
      'travel conditions do not match the active turn context',
    );
    return { field: fieldError(error), warnings: [error] };
  }
  const candidateResult = candidateFor(options, request, context);
  if (!candidateResult.ok) {
    return {
      field: candidateResult.field,
      warnings: [warningForField(candidateResult.field)].filter(
        (warning): warning is Issue => warning !== undefined,
      ),
    };
  }
  const journeyInput = journeyInputFor(options, input, request, context, candidateResult.candidate);
  if ('code' in journeyInput) return { field: fieldError(journeyInput), warnings: [journeyInput] };
  if (cancellation.isCancelled()) {
    const error = issue('CANCELLED', 'last_train', 'last-train read was cancelled');
    return { field: fieldError(error), warnings: [error] };
  }
  if (input.freshness === 'reuse_valid') {
    const reused = options.registrar.reusable(request.candidateId, context);
    if (reused !== undefined) {
      const warning = warningForField(reused);
      return { field: reused, warnings: warning === undefined ? [] : [warning] };
    }
  }
  if (input.freshness === 'refresh') {
    try {
      options.registry.invalidateObservationReuse(
        { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
        request.candidateId,
        'last_train',
      );
    } catch {
      const error = issue('MISSING_CONTEXT', 'last_train', 'observation registry is unavailable');
      return { field: fieldError(error), warnings: [error] };
    }
  }
  let journeyExecution: ToolExecutionContext;
  try {
    journeyExecution = options.executionForLastTrain(execution);
  } catch {
    const error = issue('MISSING_CONTEXT', 'last_train', 'last-train execution is unavailable');
    return { field: fieldError(error), warnings: [error] };
  }
  let result;
  try {
    result = await options.journey.read(journeyInput, context, journeyExecution, cancellation);
  } catch {
    const error = issue('UPSTREAM_UNAVAILABLE', 'last_train', 'last-train provider failed');
    return { field: fieldError(error), warnings: [error] };
  }
  if (cancellation.isCancelled()) {
    const error = issue('CANCELLED', 'last_train', 'last-train read was cancelled');
    return { field: fieldError(error), warnings: [error] };
  }
  if (result.status === 'not_applicable') {
    const field: FieldResult<unknown> = {
      status: 'not_applicable',
      reason: 'same station; walking verification is still required',
    };
    const warning = warningForField(field);
    return { field, warnings: warning === undefined ? [] : [warning] };
  }
  if (result.status === 'error')
    return { field: fieldError(result.error), warnings: [result.error] };
  const registered = options.registrar.register(request.candidateId, result.data, context, {
    source: result.source,
    verifiedAt: result.verifiedAt,
  });
  const registrationWarning = warningForField(registered);
  const warnings = [
    ...(result.status === 'partial' ? result.warnings : []),
    ...(registrationWarning === undefined ? [] : [registrationWarning]),
  ];
  return { field: registered, warnings };
};

export const createLastTrainDetailsPort = (
  options: LastTrainDetailsDispatcherOptions,
): PlaceDetailsPort => ({
  async read(input, context, execution, cancellation): Promise<Result<GetPlaceDetailsOutput>> {
    if (cancellation.isCancelled())
      return resultError(issue('CANCELLED', null, 'details read was cancelled'));
    const parsedContext = v.safeParse(HarnessContextSchema, context);
    if (!parsedContext.success)
      return resultError(issue('MISSING_CONTEXT', null, 'details context is invalid'));
    const parsedExecution = v.safeParse(ToolExecutionContextSchema, execution);
    if (!parsedExecution.success)
      return resultError(issue('STALE_TURN', null, 'details execution is invalid'));
    if (
      parsedExecution.output.operation !== 'get_place_details' ||
      parsedExecution.output.threadId !== parsedContext.output.threadId ||
      parsedExecution.output.turnId !== parsedContext.output.turnId ||
      parsedExecution.output.revision !== parsedContext.output.revision
    ) {
      return resultError(issue('STALE_TURN', null, 'details execution does not match this turn'));
    }
    const parsedInput = v.safeParse(GetPlaceDetailsInputSchema, input);
    if (!parsedInput.success)
      return resultError(issue('INVALID_ARGUMENT', 'input', 'details input is invalid'));
    const normalizedInput = parsedInput.output;
    const requests = lastTrainRequests(normalizedInput);
    const baseInput = baseInputFor(normalizedInput);
    let base: Extract<Result<GetPlaceDetailsOutput>, { status: 'ok' | 'partial' }> | undefined;
    if (baseInput !== undefined) {
      const baseResult = await options.base.read(baseInput, context, execution, cancellation);
      if (baseResult.status === 'error') return baseResult;
      base = baseResult;
    }
    if (cancellation.isCancelled()) {
      return resultError(issue('CANCELLED', 'details', 'details read was cancelled'));
    }
    const baseItems = new Map(base?.data.items.map((item) => [item.candidateId, item]) ?? []);
    const warnings: Issue[] = [...(base?.status === 'partial' ? base.warnings : [])];
    const items: unknown[] = [];
    for (const request of normalizedInput.requests) {
      const baseItem = baseItems.get(request.candidateId);
      const fields: Record<string, unknown> = {};
      for (const field of request.fields) {
        if (field === 'last_train') continue;
        const value = baseItem?.fields[field];
        if (value === undefined) {
          return resultError(
            issue('SCHEMA_MISMATCH', `items.${request.candidateId}`, 'detail field is missing'),
          );
        }
        fields[field] = value;
      }
      if (requests.some((candidate) => candidate.candidateId === request.candidateId)) {
        const lastTrain = await readLastTrain(
          options,
          normalizedInput,
          request,
          context,
          execution,
          cancellation,
        );
        fields.last_train = lastTrain.field;
        warnings.push(...lastTrain.warnings);
        if (lastTrain.field.status === 'error' && lastTrain.field.error.code === 'CANCELLED') {
          return resultError(lastTrain.field.error);
        }
      }
      items.push({ candidateId: request.candidateId, fields });
    }
    const parsedOutput = v.safeParse(GetPlaceDetailsOutputSchema, { items });
    if (!parsedOutput.success)
      return resultError(issue('SCHEMA_MISMATCH', 'items', 'details result is invalid'));
    return warnings.length === 0
      ? { status: 'ok', data: parsedOutput.output, warnings: [] }
      : { status: 'partial', data: parsedOutput.output, warnings };
  },
});
