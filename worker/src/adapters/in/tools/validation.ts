import * as v from 'valibot';
import {
  GetPlaceDetailsOutputSchema,
  ModelGetPlaceDetailsInputSchema,
  SearchPlacesInputSchema,
  SearchPlacesOutputSchema,
  type GetPlaceDetailsOutput,
  type ModelGetPlaceDetailsInput,
  type SearchPlacesInput,
  type SearchPlacesOutput,
} from '@worker/application/ports/operations';
import {
  HarnessContextSchema,
  ToolExecutionContextSchema,
  type CancellationToken,
  type HarnessContext,
  type ToolExecutionContext,
} from '@worker/application/ports/context';
import { ResultSchema, type Result } from '@worker/domain/result';
import { SubmitCardsInputSchema, type SubmitCardsInput } from '@worker/application/ports/model';
import {
  SubmitCardsPortResultSchema,
  type SubmitCardsInvalid,
  type SubmitIssueSchema,
  type SubmitCardsPortResult,
} from '@worker/application/ports/submission';
import { type CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import { type DetailField } from '@worker/domain/primitives';
import { type Issue, type IssueCode } from '@worker/domain/issue';
import type {
  PublicToolInvocation,
  PublicToolName,
  ToolRuntimeFactory,
  ToolRuntime,
} from '@worker/runtime/ports/tool-binding';

type SubmitIssue = v.InferOutput<typeof SubmitIssueSchema>;

const isCancellationToken = (value: unknown): value is CancellationToken => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!('isCancelled' in value)) return false;
  return typeof value.isCancelled === 'function';
};

const SearchResultSchema = ResultSchema(SearchPlacesOutputSchema);
const DetailsResultSchema = ResultSchema(GetPlaceDetailsOutputSchema);

export type RuntimeCheck =
  | { readonly ok: true; readonly runtime: ToolRuntime }
  | {
      readonly ok: false;
      readonly error: Issue;
    };

export const issue = (
  code: IssueCode,
  path: string | null,
  message: string,
  retryable = false,
): Issue => ({
  code,
  path,
  retryable,
  retryAfterMs: null,
  message,
  missingFields: [],
});

export const resultError = <T>(error: Issue): Result<T> => ({
  status: 'error',
  error,
});

export const submitInvalid = (
  code: SubmitIssue['code'],
  path: string | null,
  message: string,
  remainingRepairs: number,
): SubmitCardsInvalid => {
  const terminal = code === 'CANCELLED' || code === 'BUDGET_EXCEEDED';
  const boundedRepairs = Math.max(0, Math.min(2, remainingRepairs));
  return {
    status: 'invalid',
    issues: [
      {
        code,
        path,
        message,
        missingFields: [],
      },
    ],
    repairable: !terminal && boundedRepairs > 0,
    remainingRepairs: terminal ? 0 : boundedRepairs,
  };
};

export const parseSearchInput = (
  value: unknown,
): { readonly ok: true; readonly value: SearchPlacesInput } | { readonly ok: false } => {
  const parsed = v.safeParse(SearchPlacesInputSchema, value);
  return parsed.success ? { ok: true, value: parsed.output } : { ok: false };
};

export const parseDetailsInput = (
  value: unknown,
): { readonly ok: true; readonly value: ModelGetPlaceDetailsInput } | { readonly ok: false } => {
  const parsed = v.safeParse(ModelGetPlaceDetailsInputSchema, value);
  return parsed.success ? { ok: true, value: parsed.output } : { ok: false };
};

export const parseSubmitInput = (
  value: unknown,
): { readonly ok: true; readonly value: SubmitCardsInput } | { readonly ok: false } => {
  const parsed = v.safeParse(SubmitCardsInputSchema, value);
  return parsed.success ? { ok: true, value: parsed.output } : { ok: false };
};

export const parseSearchResult = (value: unknown): Result<SearchPlacesOutput> | undefined => {
  const parsed = v.safeParse(SearchResultSchema, value);
  return parsed.success ? parsed.output : undefined;
};

export const parseDetailsResult = (value: unknown): Result<GetPlaceDetailsOutput> | undefined => {
  const parsed = v.safeParse(DetailsResultSchema, value);
  return parsed.success ? parsed.output : undefined;
};

export const parseSubmitResult = (value: unknown): SubmitCardsPortResult | undefined => {
  const parsed = v.safeParse(SubmitCardsPortResultSchema, value);
  return parsed.success ? parsed.output : undefined;
};

const parsedContext = (value: unknown): HarnessContext | undefined => {
  const parsed = v.safeParse(HarnessContextSchema, value);
  return parsed.success ? parsed.output : undefined;
};

const parsedExecution = (value: unknown): ToolExecutionContext | undefined => {
  const parsed = v.safeParse(ToolExecutionContextSchema, value);
  return parsed.success ? parsed.output : undefined;
};

export const runtimeFor = (
  factory: ToolRuntimeFactory,
  operation: PublicToolName,
  invocation: PublicToolInvocation,
): RuntimeCheck => {
  let supplied: unknown;
  try {
    supplied = factory(operation, invocation);
  } catch {
    return {
      ok: false,
      error: issue('MISSING_CONTEXT', null, 'tool execution context is unavailable'),
    };
  }

  if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
    return {
      ok: false,
      error: issue('MISSING_CONTEXT', null, 'tool execution context is invalid'),
    };
  }
  if (!('context' in supplied) || !('execution' in supplied) || !('cancellation' in supplied)) {
    return {
      ok: false,
      error: issue('MISSING_CONTEXT', null, 'tool execution context is invalid'),
    };
  }
  if (!('remainingRepairs' in supplied) || typeof supplied.remainingRepairs !== 'number') {
    return {
      ok: false,
      error: issue('MISSING_CONTEXT', null, 'submit repair budget is unavailable'),
    };
  }
  const suppliedCancellation = supplied.cancellation;
  if (!isCancellationToken(suppliedCancellation)) {
    return {
      ok: false,
      error: issue('MISSING_CONTEXT', null, 'tool cancellation is unavailable'),
    };
  }
  const context = parsedContext(supplied.context);
  const execution = parsedExecution(supplied.execution);
  if (context === undefined || execution === undefined) {
    return {
      ok: false,
      error: issue('MISSING_CONTEXT', null, 'tool execution context is invalid'),
    };
  }
  if (
    execution.operation !== operation ||
    execution.threadId !== context.threadId ||
    execution.turnId !== context.turnId ||
    execution.revision !== context.revision
  ) {
    return {
      ok: false,
      error: issue('INVALID_ARGUMENT', null, 'tool execution identity is not harness-issued'),
    };
  }
  if (
    !Number.isSafeInteger(supplied.remainingRepairs) ||
    supplied.remainingRepairs < 0 ||
    supplied.remainingRepairs > 2
  ) {
    return {
      ok: false,
      error: issue('MISSING_CONTEXT', null, 'submit repair budget is invalid'),
    };
  }

  const cancellation = {
    isCancelled: (): boolean => {
      try {
        return suppliedCancellation.isCancelled() || invocation.abortSignal?.aborted === true;
      } catch {
        return true;
      }
    },
  };
  return {
    ok: true,
    runtime: {
      context,
      execution,
      cancellation,
      remainingRepairs: supplied.remainingRepairs,
    },
  };
};

export const cancellationError = <T>(runtime: ToolRuntime): Result<T> | undefined =>
  runtime.cancellation.isCancelled()
    ? resultError(issue('CANCELLED', null, 'tool execution was cancelled'))
    : undefined;

export const submitCancellationError = (runtime: ToolRuntime): SubmitCardsPortResult | undefined =>
  runtime.cancellation.isCancelled()
    ? submitInvalid('CANCELLED', null, 'tool execution was cancelled', runtime.remainingRepairs)
    : undefined;

export const unsupportedDetailField = (
  context: HarnessContext,
  input: { readonly requests: readonly { readonly fields: readonly DetailField[] }[] },
): string | undefined => {
  const fields = new Set(context.capabilities.detailFields);
  for (const request of input.requests) {
    for (const field of request.fields) {
      if (field === 'walking_route' && !context.capabilities.walkingRoute) return field;
      if (field === 'last_train' && !context.capabilities.lastTrain) return field;
      if (!fields.has(field)) return field;
    }
  }
  return undefined;
};

export const ownedCandidateIssue = (
  registry: Pick<CandidateObservationRegistryPort, 'readCandidate'>,
  context: HarnessContext,
  candidateIds: readonly string[],
  path: string,
): Issue | undefined => {
  const scope = { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId };
  for (const candidateId of candidateIds) {
    let candidate;
    try {
      candidate = registry.readCandidate(scope, candidateId);
    } catch {
      return issue('MISSING_CONTEXT', null, 'candidate registry is unavailable');
    }
    if (
      candidate === undefined ||
      candidate.ownerScopeRef !== scope.ownerScopeRef ||
      candidate.threadId !== scope.threadId
    ) {
      return issue('UNKNOWN_CANDIDATE', path, 'candidate is not owned by this thread');
    }
  }
  return undefined;
};

export const invalidOutput = (path: string): Issue =>
  issue('SCHEMA_MISMATCH', path, 'tool provider returned an invalid result');

export const mismatchedDetails = (): Issue =>
  issue('SCHEMA_MISMATCH', 'items', 'tool provider returned fields outside the request');

export const upstreamError = (): Issue =>
  issue('UPSTREAM_UNAVAILABLE', null, 'tool provider failed', true);
