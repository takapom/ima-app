import * as v from 'valibot';
import {
  GetPlaceDetailsInputSchema,
  GetPlaceDetailsOutputSchema,
  HarnessContextSchema,
  ResultSchema,
  SearchPlacesInputSchema,
  SearchPlacesOutputSchema,
  SubmitCardsInputSchema,
  SubmitCardsPortResultSchema,
  ToolExecutionContextSchema,
  type CancellationToken,
  type HarnessContext,
  type PlaceDetailsPort,
  type PlaceSearchPort,
  type GetPlaceDetailsInput,
  type GetPlaceDetailsOutput,
  type Result,
  type SearchPlacesInput,
  type SearchPlacesOutput,
  type SubmitCardsPort,
  type SubmitCardsInput,
  type SubmitCardsPortResult,
  type ToolExecutionContext,
} from '@ima/core';
import { identityObservationId, observationFor } from './runtime-gate-observations';

export type RuntimeGateCoreCall = {
  operation: 'search_places' | 'get_place_details' | 'submit_cards';
  candidateIds: string[];
  fields: string[];
  observationIds: string[];
  evidenceIds: string[];
};

export type RuntimeGatePortCall = {
  operation: RuntimeGateCoreCall['operation'];
  callId: string;
  threadId: string;
  turnId: string;
  revision: number;
  cancelled: boolean;
};

export type RuntimeGateCoreReport = {
  calls: RuntimeGateCoreCall[];
  portCalls: RuntimeGatePortCall[];
  commits: Array<{ candidateIds: string[]; evidenceIds: string[] }>;
  repairCount: number;
};

export type RuntimeGateContextIdentity = {
  threadId: string;
  turnId: string;
  revision: number;
};

/**
 * The fixture harness owns this context; model envelopes never provide it.
 * Keeping construction here makes the public Port call sites explicit while
 * avoiding a second, untyped fixture context in each Worker adapter.
 */
export function runtimeGateHarnessContext(identity: RuntimeGateContextIdentity): HarnessContext {
  return parse<HarnessContext>(
    HarnessContextSchema,
    {
      threadId: identity.threadId,
      turnId: identity.turnId,
      revision: identity.revision,
      serverNow: '2026-09-10T00:00:00Z',
      ownerScopeRef: 'runtime-gate-owner',
      location: {
        status: 'unavailable',
        coordinates: null,
        accuracyMeters: null,
        precise: false,
        capturedAt: null,
        revision: 1,
      },
      preferences: {
        homeStationRef: null,
        maxWalkMinutes: null,
        minimumStayMinutes: null,
        areaText: null,
        budget: null,
      },
      budget: {
        wallClockMs: 2_000,
        finalReserveMs: 250,
        modelCallsRemaining: 6,
        readCallsRemaining: 8,
        providerHttpRequestsRemaining: 8,
        retriesRemaining: 0,
      },
      capabilities: {
        version: 'v1',
        detailFields: ['identity', 'opening_hours', 'price'],
        walkingRoute: false,
        lastTrain: false,
        supportedScopes: ['runtime-gate-fixture'],
      },
    },
    'HARNESS_CONTEXT',
  );
}

export function runtimeGateDefaultContext(): HarnessContext {
  return runtimeGateHarnessContext({
    threadId: 'runtime-gate-fixture',
    turnId: 'turn-runtime-gate',
    revision: 1,
  });
}

export function runtimeGateExecutionContext(
  context: HarnessContext,
  operation: RuntimeGatePortCall['operation'],
  callId: string,
): ToolExecutionContext {
  return parse<ToolExecutionContext>(
    ToolExecutionContextSchema,
    {
      callId,
      operation,
      threadId: context.threadId,
      turnId: context.turnId,
      revision: context.revision,
    },
    'TOOL_EXECUTION_CONTEXT',
  );
}

export function runtimeGateCancellation(signal: AbortSignal | undefined): CancellationToken {
  return { isCancelled: () => signal?.aborted === true };
}

function parse<T>(schema: v.GenericSchema<unknown, T>, value: unknown, label: string): T {
  const result = v.safeParse(schema, value);
  if (!result.success) throw new Error(`RUNTIME_GATE_${label}_SCHEMA_MISMATCH`);
  return result.output;
}

function emptyCall(operation: RuntimeGateCoreCall['operation']): RuntimeGateCoreCall {
  return { operation, candidateIds: [], fields: [], observationIds: [], evidenceIds: [] };
}

function issue(code: 'MISSING_EVIDENCE' | 'INVALID_EVIDENCE', candidateId?: string) {
  return {
    code,
    path: 'hero.evidenceIds',
    ...(candidateId === undefined ? {} : { candidateId }),
    message:
      code === 'MISSING_EVIDENCE'
        ? 'identity evidence is required'
        : 'evidence is not identity evidence',
    missingFields: code === 'MISSING_EVIDENCE' ? ['hero.evidenceIds'] : [],
  };
}

/** SDK compatibility stub; identity-only checks do not replace the M09 business validator. */
export class RuntimeGateCore implements PlaceSearchPort, PlaceDetailsPort, SubmitCardsPort {
  readonly report: RuntimeGateCoreReport = {
    calls: [],
    portCalls: [],
    commits: [],
    repairCount: 0,
  };

  private recordPortCall(
    operation: RuntimeGatePortCall['operation'],
    context: HarnessContext,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): void {
    const parsedContext = parse<HarnessContext>(HarnessContextSchema, context, 'HARNESS_CONTEXT');
    const parsedExecution = parse<ToolExecutionContext>(
      ToolExecutionContextSchema,
      execution,
      'TOOL_EXECUTION_CONTEXT',
    );
    if (
      parsedExecution.operation !== operation ||
      parsedExecution.threadId !== parsedContext.threadId ||
      parsedExecution.turnId !== parsedContext.turnId ||
      parsedExecution.revision !== parsedContext.revision
    ) {
      throw new Error('RUNTIME_GATE_PORT_CONTEXT_MISMATCH');
    }
    this.report.portCalls.push({
      operation,
      callId: parsedExecution.callId,
      threadId: parsedExecution.threadId,
      turnId: parsedExecution.turnId,
      revision: parsedExecution.revision,
      cancelled: cancellation.isCancelled(),
    });
  }

  private cancelledResult<T>(): Result<T> {
    return {
      status: 'error',
      error: {
        code: 'CANCELLED',
        path: null,
        retryable: false,
        retryAfterMs: null,
        message: 'operation cancelled',
        missingFields: [],
      },
    };
  }

  private cancelledSubmitResult(): SubmitCardsPortResult {
    return {
      status: 'invalid',
      issues: [
        {
          code: 'CANCELLED',
          path: null,
          message: 'operation cancelled',
          missingFields: [],
        },
      ],
      repairable: false,
      remainingRepairs: 0,
    };
  }

  async search(
    input: SearchPlacesInput,
    context: HarnessContext,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<Result<SearchPlacesOutput>> {
    this.recordPortCall('search_places', context, execution, cancellation);
    if (cancellation.isCancelled()) return this.cancelledResult<SearchPlacesOutput>();
    return await Promise.resolve(this.searchPlaces(input));
  }

  async read(
    input: GetPlaceDetailsInput,
    context: HarnessContext,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<Result<GetPlaceDetailsOutput>> {
    this.recordPortCall('get_place_details', context, execution, cancellation);
    if (cancellation.isCancelled()) return this.cancelledResult<GetPlaceDetailsOutput>();
    return await Promise.resolve(this.getPlaceDetails(input));
  }

  async submit(
    input: SubmitCardsInput,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<SubmitCardsPortResult> {
    const context = runtimeGateHarnessContext({
      threadId: execution.threadId,
      turnId: execution.turnId,
      revision: execution.revision,
    });
    this.recordPortCall('submit_cards', context, execution, cancellation);
    if (cancellation.isCancelled()) return this.cancelledSubmitResult();
    return await Promise.resolve(this.submitCards(input));
  }

  searchPlaces(input: SearchPlacesInput): Result<SearchPlacesOutput> {
    const parsedInput = parse<SearchPlacesInput>(SearchPlacesInputSchema, input, 'SEARCH_INPUT');
    const call = emptyCall('search_places');
    call.fields.push('identity', 'opening_hours');
    this.report.calls.push(call);

    const data = {
      searchId: 'search-runtime-gate',
      candidates: [],
      applied: {
        areaDescription: parsedInput.mode === 'search' ? parsedInput.area.kind : 'continued-search',
        openNow: parsedInput.mode === 'search' ? parsedInput.openNow : false,
        excludedCount: parsedInput.mode === 'search' ? parsedInput.excludeCandidateIds.length : 0,
      },
      nextCursor: null,
      coverage: 'provider_results' as const,
    } satisfies SearchPlacesOutput;
    return parse<Result<SearchPlacesOutput>>(
      ResultSchema(SearchPlacesOutputSchema),
      { status: 'ok', data, warnings: [] },
      'SEARCH_OUTPUT',
    );
  }

  getPlaceDetails(input: GetPlaceDetailsInput): Result<GetPlaceDetailsOutput> {
    const parsedInput = parse<GetPlaceDetailsInput>(
      GetPlaceDetailsInputSchema,
      input,
      'DETAILS_INPUT',
    );
    const call = emptyCall('get_place_details');
    const items = parsedInput.requests.map((request) => {
      call.candidateIds.push(request.candidateId);
      const fields: GetPlaceDetailsOutput['items'][number]['fields'] = {};
      request.fields.forEach((field) => {
        call.fields.push(field);
        if (field === 'identity') {
          const observation = observationFor(request.candidateId, field);
          call.observationIds.push(observation.observationId);
          fields.identity = { status: 'known', observations: [observation] };
        } else if (field === 'opening_hours') {
          const observation = observationFor(request.candidateId, field);
          call.observationIds.push(observation.observationId);
          fields.opening_hours = { status: 'known', observations: [observation] };
        } else {
          fields[field] = {
            status: 'unsupported',
            reason: 'runtime gate fixture does not provide this field',
          };
        }
      });
      return { candidateId: request.candidateId, fields };
    });
    this.report.calls.push(call);

    const data = { items } satisfies GetPlaceDetailsOutput;
    return parse<Result<GetPlaceDetailsOutput>>(
      ResultSchema(GetPlaceDetailsOutputSchema),
      { status: 'ok', data, warnings: [] },
      'DETAILS_OUTPUT',
    );
  }

  submitCards(input: SubmitCardsInput): SubmitCardsPortResult {
    const parsedInput = parse<SubmitCardsInput>(SubmitCardsInputSchema, input, 'SUBMIT_INPUT');
    const call = emptyCall('submit_cards');
    const selections = [parsedInput.hero, ...parsedInput.alts];
    const candidateIds = selections.map((selection) => selection.candidateId);
    const evidenceIds = selections.flatMap((selection) => selection.evidenceIds);
    call.candidateIds.push(...candidateIds);
    call.evidenceIds.push(...evidenceIds);
    this.report.calls.push(call);

    const missing = selections.find((selection) => selection.evidenceIds.length === 0);
    const wrongEvidence = selections.find((selection) =>
      selection.evidenceIds.some(
        (evidenceId) => evidenceId !== identityObservationId(selection.candidateId),
      ),
    );
    if (missing !== undefined || wrongEvidence !== undefined) {
      this.report.repairCount += 1;
      const invalid = {
        status: 'invalid' as const,
        issues: [
          issue(
            missing === undefined ? 'INVALID_EVIDENCE' : 'MISSING_EVIDENCE',
            (missing ?? wrongEvidence)?.candidateId,
          ),
        ],
        repairable: this.report.repairCount < 3,
        remainingRepairs: Math.max(0, 3 - this.report.repairCount),
      } satisfies SubmitCardsPortResult;
      return parse<SubmitCardsPortResult>(SubmitCardsPortResultSchema, invalid, 'SUBMIT_INVALID');
    }

    const committed = {
      status: 'committed' as const,
      responseId: `response-runtime-gate-${this.report.commits.length + 1}`,
      revision: this.report.commits.length + 1,
      presentation: 'replace' as const,
      cards: parsedInput,
    } satisfies SubmitCardsPortResult;
    this.report.commits.push({ candidateIds, evidenceIds });
    return parse<SubmitCardsPortResult>(SubmitCardsPortResultSchema, committed, 'SUBMIT_COMMITTED');
  }
}
