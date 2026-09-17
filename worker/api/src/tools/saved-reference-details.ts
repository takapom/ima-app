import * as v from 'valibot';
import {
  CandidateIdSchema,
  IssueSchema,
  type CancellationToken,
  type CandidateId,
  type CandidateObservationRegistryPort,
  type DetailField,
  type GetPlaceDetailsInput,
  type HarnessContext,
  type Issue,
  type ModelDetailsRequest,
  type ModelGetPlaceDetailsInput,
  type SavedPlaceRef,
  type ToolExecutionContext,
} from '@ima/core';
import type {
  DetailsToolResult,
  SafeDetailsTarget,
  SafeGetPlaceDetailsOutput,
  SafePlaceFields,
  SavedPlaceReferenceResolver,
} from '@api/tools/types';
import { issue } from '@api/tools/validation';

export type SavedDetailsFailure = {
  readonly savedPlaceRef: SavedPlaceRef;
  readonly fields: readonly DetailField[];
  readonly error: Issue;
};

export type ResolvedModelDetails = {
  /** Candidate-only input for the Core details Port; absent when every reference failed. */
  readonly input: GetPlaceDetailsInput | undefined;
  /** Maps an internally resolved candidate back to the model's opaque target. */
  readonly targetForCandidate: (candidateId: string) => SafeDetailsTarget;
  readonly failures: readonly SavedDetailsFailure[];
  readonly warnings: readonly Issue[];
  readonly cancelled: boolean;
};

type ResolverDependencies = {
  readonly registry: Pick<CandidateObservationRegistryPort, 'readCandidate'>;
  readonly resolver: SavedPlaceReferenceResolver | undefined;
};

type UnknownRecord = { readonly [key: string]: unknown };

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const scopeFor = (context: HarnessContext) => ({
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
});

const failure = (
  savedPlaceRef: SavedPlaceRef,
  fields: readonly DetailField[],
  error: Issue,
): SavedDetailsFailure => ({
  savedPlaceRef,
  fields: [...fields],
  error,
});

const unavailableResolver = (path: string): Issue =>
  issue('MISSING_CONTEXT', path, 'saved-place resolver is unavailable');

const resolverFailure = (path: string): Issue =>
  issue('UPSTREAM_UNAVAILABLE', path, 'saved-place resolver failed', true);

const RESOLVER_CANCELLED = Symbol('saved-reference-resolver-cancelled');

const resolveWithSignal = async (
  resolver: SavedPlaceReferenceResolver,
  request: Parameters<SavedPlaceReferenceResolver>[0],
  signal: AbortSignal | undefined,
): Promise<unknown> => {
  if (signal?.aborted === true) return RESOLVER_CANCELLED;
  const operation = Promise.resolve()
    .then(() => resolver(request))
    .then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
  if (signal === undefined) {
    const settled = await operation;
    if (settled.kind === 'error') throw settled.error;
    return settled.value;
  }
  let removeAbort = (): void => undefined;
  const cancelled = new Promise<{ readonly kind: 'cancelled' }>((resolve) => {
    const onAbort = (): void => resolve({ kind: 'cancelled' });
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = (): void => signal.removeEventListener('abort', onAbort);
  });
  const settled = await Promise.race([operation, cancelled]);
  removeAbort();
  if (settled.kind === 'cancelled') return RESOLVER_CANCELLED;
  if (settled.kind === 'error') throw settled.error;
  return settled.value;
};

const normalizedIssue = (value: unknown, path: string): Issue => {
  const parsed = v.safeParse(IssueSchema, value);
  if (!parsed.success) return resolverFailure(path);
  return issue(
    parsed.output.code,
    path,
    'saved reference resolution failed',
    parsed.output.retryable,
  );
};

const candidateIssue = (
  registry: Pick<CandidateObservationRegistryPort, 'readCandidate'>,
  context: HarnessContext,
  candidateId: CandidateId,
  path: string,
): Issue | undefined => {
  let candidate;
  try {
    candidate = registry.readCandidate(scopeFor(context), candidateId);
  } catch {
    return issue('MISSING_CONTEXT', path, 'candidate registry is unavailable');
  }
  return candidate !== undefined &&
    candidate.candidateId === candidateId &&
    candidate.ownerScopeRef === context.ownerScopeRef &&
    candidate.threadId === context.threadId
    ? undefined
    : issue('UNKNOWN_CANDIDATE', path, 'saved reference resolved outside this thread');
};

const directRequest = (
  request: Extract<ModelDetailsRequest, { readonly candidateId: CandidateId }>,
): GetPlaceDetailsInput['requests'][number] => ({
  candidateId: request.candidateId,
  fields: [...request.fields],
});

/**
 * Resolves only saved references explicitly selected by the model. Provider identity and payload
 * remain behind the injected Worker boundary; the Core details Port receives candidate IDs only.
 */
export const resolveModelDetailsInput = async (
  input: ModelGetPlaceDetailsInput,
  context: HarnessContext,
  execution: ToolExecutionContext,
  cancellation: CancellationToken,
  dependencies: ResolverDependencies,
  signal?: AbortSignal,
): Promise<ResolvedModelDetails> => {
  const effectiveCancellation: CancellationToken =
    signal === undefined
      ? cancellation
      : { isCancelled: () => cancellation.isCancelled() || signal.aborted };
  const coreRequests: GetPlaceDetailsInput['requests'][number][] = [];
  const failures: SavedDetailsFailure[] = [];
  const warnings: Issue[] = [];
  const targetByCandidate = new Map<CandidateId, SafeDetailsTarget>();
  const usedCandidates = new Set<CandidateId>();

  for (const request of input.requests) {
    if ('candidateId' in request) {
      coreRequests.push(directRequest(request));
      usedCandidates.add(request.candidateId);
      targetByCandidate.set(request.candidateId, { candidateId: request.candidateId });
    }
  }

  for (const [index, request] of input.requests.entries()) {
    if (!('savedPlaceRef' in request)) continue;
    if (effectiveCancellation.isCancelled()) {
      return {
        input: undefined,
        targetForCandidate: (candidateId) => ({ candidateId }),
        failures,
        warnings,
        cancelled: true,
      };
    }
    const path = `requests.${index}.savedPlaceRef`;
    if (dependencies.resolver === undefined) {
      failures.push(failure(request.savedPlaceRef, request.fields, unavailableResolver(path)));
      continue;
    }
    let resolved: unknown;
    try {
      resolved = await resolveWithSignal(
        dependencies.resolver,
        {
          savedPlaceRef: request.savedPlaceRef,
          fields: [...request.fields],
          context,
          execution,
          cancellation: effectiveCancellation,
          ...(signal === undefined ? {} : { signal }),
        },
        signal,
      );
    } catch {
      if (effectiveCancellation.isCancelled()) {
        return {
          input: undefined,
          targetForCandidate: (candidateId) => ({ candidateId }),
          failures,
          warnings,
          cancelled: true,
        };
      }
      failures.push(failure(request.savedPlaceRef, request.fields, resolverFailure(path)));
      continue;
    }
    if (resolved === RESOLVER_CANCELLED) {
      return {
        input: undefined,
        targetForCandidate: (candidateId) => ({ candidateId }),
        failures,
        warnings,
        cancelled: true,
      };
    }
    if (effectiveCancellation.isCancelled()) {
      return {
        input: undefined,
        targetForCandidate: (candidateId) => ({ candidateId }),
        failures,
        warnings,
        cancelled: true,
      };
    }
    if (!isRecord(resolved) || (resolved.status !== 'error' && resolved.status !== 'ok')) {
      failures.push(
        failure(
          request.savedPlaceRef,
          request.fields,
          issue('SCHEMA_MISMATCH', path, 'saved reference resolver returned an invalid result'),
        ),
      );
      continue;
    }
    if (resolved.status === 'error') {
      failures.push(
        failure(request.savedPlaceRef, request.fields, normalizedIssue(resolved.error, path)),
      );
      continue;
    }
    const candidate = v.safeParse(CandidateIdSchema, resolved.candidateId);
    if (!candidate.success) {
      failures.push(
        failure(
          request.savedPlaceRef,
          request.fields,
          issue('SCHEMA_MISMATCH', path, 'saved reference resolver returned an invalid candidate'),
        ),
      );
      continue;
    }
    const resolverWarnings = resolved.warnings;
    if (resolverWarnings !== undefined) {
      if (!Array.isArray(resolverWarnings)) {
        failures.push(
          failure(
            request.savedPlaceRef,
            request.fields,
            issue(
              'SCHEMA_MISMATCH',
              `${path}.warnings`,
              'saved reference resolver returned invalid warnings',
            ),
          ),
        );
        continue;
      }
      const parsedWarnings = resolverWarnings.map((warning) => v.safeParse(IssueSchema, warning));
      if (parsedWarnings.some((warning) => !warning.success)) {
        failures.push(
          failure(
            request.savedPlaceRef,
            request.fields,
            issue(
              'SCHEMA_MISMATCH',
              `${path}.warnings`,
              'saved reference resolver returned invalid warnings',
            ),
          ),
        );
        continue;
      }
      for (const warning of parsedWarnings) {
        if (warning.success) warnings.push(normalizedIssue(warning.output, path));
      }
    }
    const owned = candidateIssue(dependencies.registry, context, candidate.output, path);
    if (owned !== undefined) {
      failures.push(failure(request.savedPlaceRef, request.fields, owned));
      continue;
    }
    if (usedCandidates.has(candidate.output)) {
      failures.push(
        failure(
          request.savedPlaceRef,
          request.fields,
          issue('INVALID_ARGUMENT', path, 'saved reference resolves to a duplicate candidate'),
        ),
      );
      continue;
    }
    usedCandidates.add(candidate.output);
    coreRequests.push({ candidateId: candidate.output, fields: [...request.fields] });
    targetByCandidate.set(candidate.output, {
      candidateId: candidate.output,
      savedPlaceRef: request.savedPlaceRef,
    });
  }

  if (effectiveCancellation.isCancelled()) {
    return {
      input: undefined,
      targetForCandidate: (candidateId) => ({ candidateId }),
      failures,
      warnings,
      cancelled: true,
    };
  }

  const coreInput =
    coreRequests.length === 0
      ? undefined
      : {
          requests: coreRequests,
          freshness: input.freshness,
          ...(input.travelContext === undefined ? {} : { travelContext: input.travelContext }),
        };
  return {
    input: coreInput,
    targetForCandidate: (candidateId) => targetByCandidate.get(candidateId) ?? { candidateId },
    failures,
    warnings,
    cancelled: false,
  };
};

const errorField = (error: Issue) => ({ status: 'error' as const, error });

const failureFields = (fields: readonly DetailField[], error: Issue): SafePlaceFields => {
  const projected: Partial<Record<DetailField, ReturnType<typeof errorField>>> = {};
  for (const field of fields) {
    projected[field] = errorField(error);
  }
  return projected;
};

const failureItems = (
  failures: readonly SavedDetailsFailure[],
): SafeGetPlaceDetailsOutput['items'] =>
  failures.map((entry) => ({
    savedPlaceRef: entry.savedPlaceRef,
    fields: failureFields(entry.fields, entry.error),
  }));

export const detailsResultForSavedFailures = (
  failures: readonly SavedDetailsFailure[],
  warnings: readonly Issue[],
): DetailsToolResult => ({
  status: 'partial',
  data: { items: failureItems(failures) },
  warnings: [...warnings, ...failures.map((entry) => entry.error)],
});

export const mergeSavedDetailsFailures = (
  result: DetailsToolResult,
  failures: readonly SavedDetailsFailure[],
  warnings: readonly Issue[],
): DetailsToolResult => {
  if (result.status === 'error' || (failures.length === 0 && warnings.length === 0)) return result;
  if (result.status !== 'ok' && result.status !== 'partial') return result;
  return {
    status: 'partial',
    data: { items: [...result.data.items, ...failureItems(failures)] },
    warnings: [...result.warnings, ...warnings, ...failures.map((entry) => entry.error)],
  };
};
