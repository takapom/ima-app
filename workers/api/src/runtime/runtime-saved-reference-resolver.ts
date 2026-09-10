import * as v from 'valibot';
import {
  CandidateRegistrationSchema,
  CandidateIdSchema,
  DetailFieldSchema,
  HarnessContextSchema,
  IsoTimestampSchema,
  IssueSchema,
  SavedPlaceReferenceSchema,
  SavedPlaceRefSchema,
  ToolExecutionContextSchema,
  type CandidateRecord,
  type CandidateRegistration,
  type CancellationToken,
  type HarnessContext,
  type Issue,
  type RegistryScope,
  type SavedPlaceReference,
  type SavedPlaceRef,
} from '@ima/core';
import type { SavedPlaceReferenceResolver } from '../tools/types';
import type {
  SavedReferenceCandidateRegistry,
  SavedReferenceHandoffBinding,
  SavedReferenceProviderRefresher,
} from '../providers/places-details/handoff';

export type {
  SavedReferenceProviderRefreshRequest,
  SavedReferenceProviderRefresher,
} from '../providers/places-details/handoff';

const OwnerReadResultSchema = v.union([
  v.strictObject({
    ok: v.literal(true),
    reference: v.nullable(SavedPlaceReferenceSchema),
  }),
  v.strictObject({
    ok: v.literal(false),
    code: v.picklist(['INVALID_INPUT', 'OWNER_NOT_INITIALIZED', 'FORBIDDEN', 'CORRUPT_ROW']),
  }),
]);

const ProviderRefreshResultSchema = v.union([
  v.strictObject({
    status: v.literal('ok'),
    candidate: CandidateRegistrationSchema,
    warnings: v.optional(v.pipe(v.array(IssueSchema), v.maxLength(8))),
  }),
  v.strictObject({
    status: v.literal('error'),
    error: IssueSchema,
  }),
]);

const DetailFieldsSchema = v.pipe(
  v.array(DetailFieldSchema),
  v.minLength(1),
  v.maxLength(8),
  v.check((fields) => new Set(fields).size === fields.length, 'duplicate detail field'),
);

export type SavedReferenceOwnerReader = {
  /** The RPC is already owner-bound; its unknown result is validated below. */
  readonly read: (savedPlaceRef: unknown) => Promise<unknown>;
};

export type SavedReferenceRefreshBudget = {
  /** Reserves exactly one provider request before the provider boundary is entered. */
  readonly reserveProviderRequest: () => boolean;
};

export type SavedReferenceResolverDependencies = {
  readonly owner: SavedReferenceOwnerReader;
  readonly provider: SavedReferenceProviderRefresher;
  readonly registry: SavedReferenceCandidateRegistry;
  /** Explicit allowlist supplied by the provider composition. */
  readonly supportedProviders: readonly string[];
  readonly budget: SavedReferenceRefreshBudget;
  /** Server clock and the immutable session deadline are supplied by the Host. */
  readonly now: () => string;
  readonly sessionExpiresAt: () => string | undefined;
};

const issue = (
  code: Issue['code'],
  path: string | null,
  message: string,
  retryable = false,
  retryAfterMs: number | null = null,
): Issue => ({
  code,
  path,
  retryable,
  retryAfterMs,
  message,
  missingFields: [],
});

const savedPath = 'savedPlaceRef';

const fixedProviderIssue = (value: unknown, path: string): Issue => {
  const parsed = v.safeParse(IssueSchema, value);
  if (!parsed.success) return issue('SCHEMA_MISMATCH', path, 'provider refresh result is invalid');
  return issue(
    parsed.output.code,
    path,
    'saved place provider refresh failed',
    parsed.output.retryable,
    parsed.output.retryAfterMs,
  );
};

const fixedWarning = (value: Issue, path: string): Issue =>
  issue(value.code, path, 'saved place provider refresh returned a warning', value.retryable);

const ownerFailure = (
  code: 'INVALID_INPUT' | 'OWNER_NOT_INITIALIZED' | 'FORBIDDEN' | 'CORRUPT_ROW',
): Issue => {
  switch (code) {
    case 'INVALID_INPUT':
      return issue('INVALID_ARGUMENT', savedPath, 'saved reference input is invalid');
    case 'OWNER_NOT_INITIALIZED':
      return issue('MISSING_CONTEXT', savedPath, 'saved reference owner is unavailable');
    case 'FORBIDDEN':
      return issue('UNSUPPORTED_SCOPE', savedPath, 'saved reference is outside this owner');
    case 'CORRUPT_ROW':
      return issue('SCHEMA_MISMATCH', savedPath, 'saved reference is invalid');
  }
};

type OwnerReferenceRead =
  | { readonly ok: true; readonly reference: SavedPlaceReference }
  | { readonly ok: false; readonly error: Issue };

const cancelledIssue = (): Issue => issue('CANCELLED', savedPath, 'saved reference read cancelled');

const cancellationState = (cancellation: CancellationToken): boolean => {
  try {
    return cancellation.isCancelled();
  } catch {
    return true;
  }
};

const scopeFor = (context: HarnessContext): RegistryScope => ({
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
});

const freshnessIssue = (dependencies: SavedReferenceResolverDependencies): Issue | undefined => {
  let nowValue: string;
  let expiresValue: string | undefined;
  try {
    nowValue = dependencies.now();
    expiresValue = dependencies.sessionExpiresAt();
  } catch {
    return issue('MISSING_CONTEXT', savedPath, 'saved reference clock is unavailable');
  }
  if (!v.safeParse(IsoTimestampSchema, nowValue).success) {
    return issue('MISSING_CONTEXT', savedPath, 'saved reference clock is invalid');
  }
  if (expiresValue === undefined || !v.safeParse(IsoTimestampSchema, expiresValue).success) {
    return issue('MISSING_CONTEXT', savedPath, 'saved reference session deadline is unavailable');
  }
  return Date.parse(nowValue) >= Date.parse(expiresValue)
    ? issue('STALE_TURN', savedPath, 'saved reference session has expired')
    : undefined;
};

const invalidContextIssue = (): Issue =>
  issue('MISSING_CONTEXT', savedPath, 'saved reference runtime context is invalid');

const invalidExecutionIssue = (): Issue =>
  issue('INVALID_ARGUMENT', savedPath, 'saved reference execution identity is invalid');

const providerUnavailable = (): Issue =>
  issue('UPSTREAM_UNAVAILABLE', savedPath, 'saved place provider is unavailable');

const ownerReferenceFor = async (
  dependencies: SavedReferenceResolverDependencies,
  request: Parameters<SavedPlaceReferenceResolver>[0],
  savedPlaceRef: SavedPlaceRef,
): Promise<OwnerReferenceRead> => {
  let ownerResult: unknown;
  try {
    ownerResult = await dependencies.owner.read(savedPlaceRef);
  } catch {
    if (cancellationState(request.cancellation)) return { ok: false, error: cancelledIssue() };
    return { ok: false, error: providerUnavailable() };
  }
  if (cancellationState(request.cancellation)) return { ok: false, error: cancelledIssue() };
  const freshness = freshnessIssue(dependencies);
  if (freshness !== undefined) return { ok: false, error: freshness };
  const parsed = v.safeParse(OwnerReadResultSchema, ownerResult);
  if (!parsed.success) {
    return {
      ok: false,
      error: issue('SCHEMA_MISMATCH', savedPath, 'saved reference owner result is invalid'),
    };
  }
  if (!parsed.output.ok) return { ok: false, error: ownerFailure(parsed.output.code) };
  if (parsed.output.reference === null) {
    return {
      ok: false,
      error: issue('UNKNOWN_CANDIDATE', savedPath, 'saved reference was not found'),
    };
  }
  if (
    parsed.output.reference.savedPlaceRef !== savedPlaceRef ||
    parsed.output.reference.ownerScopeRef !== request.context.ownerScopeRef
  ) {
    return {
      ok: false,
      error: issue('UNSUPPORTED_SCOPE', savedPath, 'saved reference is outside this owner'),
    };
  }
  return { ok: true, reference: parsed.output.reference };
};

const readExisting = (
  dependencies: SavedReferenceResolverDependencies,
  scope: RegistryScope,
  reference: SavedPlaceReference,
): { readonly error?: Issue } => {
  let candidates: readonly Readonly<{
    readonly candidateId: string;
    readonly ownerScopeRef: string;
    readonly threadId: string;
    readonly provider: string;
    readonly recordRef: string;
    readonly excluded: boolean;
  }>[];
  try {
    candidates = dependencies.registry.listCandidates(scope);
  } catch {
    return { error: issue('MISSING_CONTEXT', savedPath, 'candidate registry is unavailable') };
  }
  const existing = candidates.find(
    (candidate) =>
      candidate.ownerScopeRef === scope.ownerScopeRef &&
      candidate.threadId === scope.threadId &&
      candidate.provider === reference.provider &&
      candidate.recordRef === reference.recordRef,
  );
  if (existing === undefined) return {};
  return existing.excluded
    ? { error: issue('EXCLUDED_CANDIDATE', savedPath, 'saved reference candidate is excluded') }
    : {};
};

const validContextAndExecution = (
  request: Parameters<SavedPlaceReferenceResolver>[0],
): Issue | undefined => {
  if (!v.safeParse(HarnessContextSchema, request.context).success) return invalidContextIssue();
  if (!v.safeParse(ToolExecutionContextSchema, request.execution).success) {
    return invalidExecutionIssue();
  }
  if (
    request.execution.operation !== 'get_place_details' ||
    request.execution.threadId !== request.context.threadId ||
    request.execution.turnId !== request.context.turnId ||
    request.execution.revision !== request.context.revision
  ) {
    return invalidExecutionIssue();
  }
  return undefined;
};

const matchesScope = (
  candidate: Pick<CandidateRegistration, 'ownerScopeRef' | 'threadId' | 'provider' | 'recordRef'>,
  scope: RegistryScope,
  reference: SavedPlaceReference,
): boolean =>
  candidate.ownerScopeRef === scope.ownerScopeRef &&
  candidate.threadId === scope.threadId &&
  candidate.provider === reference.provider &&
  candidate.recordRef === reference.recordRef;

const resolveProviderResult = (
  value: unknown,
  scope: RegistryScope,
  reference: SavedPlaceReference,
):
  | {
      readonly ok: true;
      readonly candidate: CandidateRegistration;
      readonly warnings: readonly Issue[];
    }
  | { readonly ok: false; readonly error: Issue } => {
  const parsed = v.safeParse(ProviderRefreshResultSchema, value);
  if (!parsed.success) {
    return {
      ok: false,
      error: issue('SCHEMA_MISMATCH', savedPath, 'provider refresh result is invalid'),
    };
  }
  if (parsed.output.status === 'error') {
    return { ok: false, error: fixedProviderIssue(parsed.output.error, savedPath) };
  }
  if (!matchesScope(parsed.output.candidate, scope, reference)) {
    return {
      ok: false,
      error: issue(
        'SCHEMA_MISMATCH',
        savedPath,
        'provider refresh identity does not match reference',
      ),
    };
  }
  const warnings = (parsed.output.warnings ?? []).map((warning) =>
    fixedWarning(warning, savedPath),
  );
  return { ok: true, candidate: parsed.output.candidate, warnings };
};

/**
 * Resolves a model-selected saved reference without creating a candidate until a fresh provider
 * result has passed the owner, scope, expiry, cancellation, and budget gates.
 */
export const createSavedPlaceReferenceResolver =
  (dependencies: SavedReferenceResolverDependencies): SavedPlaceReferenceResolver =>
  async (request) => {
    const contextError = validContextAndExecution(request);
    if (contextError !== undefined) return { status: 'error', error: contextError };
    if (cancellationState(request.cancellation)) {
      return { status: 'error', error: cancelledIssue() };
    }
    const savedRef = v.safeParse(SavedPlaceRefSchema, request.savedPlaceRef);
    if (!savedRef.success) {
      return {
        status: 'error',
        error: issue('INVALID_ARGUMENT', savedPath, 'saved reference input is invalid'),
      };
    }
    const fields = v.safeParse(DetailFieldsSchema, request.fields);
    if (!fields.success) {
      return {
        status: 'error',
        error: issue(
          'INVALID_ARGUMENT',
          `${savedPath}.fields`,
          'saved reference fields are invalid',
        ),
      };
    }
    const freshnessBeforeRead = freshnessIssue(dependencies);
    if (freshnessBeforeRead !== undefined) return { status: 'error', error: freshnessBeforeRead };

    const ownerRead = await ownerReferenceFor(dependencies, request, savedRef.output);
    if (!ownerRead.ok) return { status: 'error', error: ownerRead.error };
    const reference = ownerRead.reference;
    if (!dependencies.supportedProviders.includes(reference.provider)) {
      return {
        status: 'error',
        error: issue('UNSUPPORTED_SCOPE', savedPath, 'saved reference provider is unsupported'),
      };
    }

    const scope = scopeFor(request.context);
    const existing = readExisting(dependencies, scope, reference);
    if (existing.error !== undefined) return { status: 'error', error: existing.error };
    if (cancellationState(request.cancellation)) {
      return { status: 'error', error: cancelledIssue() };
    }
    const freshnessBeforeProvider = freshnessIssue(dependencies);
    if (freshnessBeforeProvider !== undefined) {
      return { status: 'error', error: freshnessBeforeProvider };
    }
    let reserved: boolean;
    try {
      reserved = dependencies.budget.reserveProviderRequest();
    } catch {
      return {
        status: 'error',
        error: issue('MISSING_CONTEXT', savedPath, 'provider budget is unavailable'),
      };
    }
    if (!reserved) {
      return {
        status: 'error',
        error: issue('BUDGET_EXCEEDED', savedPath, 'provider request budget is exhausted'),
      };
    }
    if (cancellationState(request.cancellation)) {
      return { status: 'error', error: cancelledIssue() };
    }

    let providerResult: unknown;
    try {
      providerResult = await dependencies.provider.refresh({
        savedPlaceRef: savedRef.output,
        reference,
        scope,
        fields: [...fields.output],
        context: request.context,
        execution: request.execution,
        cancellation: request.cancellation,
      });
    } catch {
      if (cancellationState(request.cancellation)) {
        return { status: 'error', error: cancelledIssue() };
      }
      return { status: 'error', error: providerUnavailable() };
    }
    if (cancellationState(request.cancellation)) {
      return { status: 'error', error: cancelledIssue() };
    }
    const freshnessAfterProvider = freshnessIssue(dependencies);
    if (freshnessAfterProvider !== undefined) {
      return { status: 'error', error: freshnessAfterProvider };
    }
    const resolved = resolveProviderResult(providerResult, scope, reference);
    if (!resolved.ok) {
      return { status: 'error', error: resolved.error };
    }
    const latestOwnerRead = await ownerReferenceFor(dependencies, request, savedRef.output);
    if (!latestOwnerRead.ok) return { status: 'error', error: latestOwnerRead.error };
    if (
      latestOwnerRead.reference.ownerScopeRef !== reference.ownerScopeRef ||
      latestOwnerRead.reference.provider !== reference.provider ||
      latestOwnerRead.reference.recordRef !== reference.recordRef
    ) {
      return {
        status: 'error',
        error: issue('UNKNOWN_CANDIDATE', savedPath, 'saved reference changed during refresh'),
      };
    }
    const currentExisting = readExisting(dependencies, scope, reference);
    if (currentExisting.error !== undefined) {
      return { status: 'error', error: currentExisting.error };
    }
    let registered: Readonly<CandidateRecord>;
    try {
      const binding: SavedReferenceHandoffBinding = {
        savedPlaceRef: savedRef.output,
        scope,
        turnId: request.execution.turnId,
        revision: request.execution.revision,
      };
      registered = dependencies.registry.registerCandidate(resolved.candidate, binding);
    } catch {
      return {
        status: 'error',
        error: issue('MISSING_CONTEXT', savedPath, 'candidate registry is unavailable'),
      };
    }
    const registeredShape = v.safeParse(CandidateRegistrationSchema, {
      ownerScopeRef: registered.ownerScopeRef,
      threadId: registered.threadId,
      provider: registered.provider,
      recordRef: registered.recordRef,
      displayName: registered.displayName,
      status: registered.status,
    });
    if (
      !v.safeParse(CandidateIdSchema, registered.candidateId).success ||
      !registeredShape.success ||
      !matchesScope(registered, scope, reference) ||
      registered.excluded
    ) {
      return {
        status: 'error',
        error: issue('SCHEMA_MISMATCH', savedPath, 'candidate registry returned an invalid result'),
      };
    }
    return {
      status: 'ok',
      candidateId: registered.candidateId,
      ...(resolved.warnings.length === 0 ? {} : { warnings: resolved.warnings }),
    };
  };
