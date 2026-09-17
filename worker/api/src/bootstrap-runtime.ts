import * as v from 'valibot';
import {
  AssistantResponseSchema,
  SearchResponseSchema,
  ThreadReadResponseSchema,
  type SearchRequest,
  type ThreadTurnRequest,
} from '@ima/contracts';
import type {
  ApplicationHandler,
  ApplicationOperation,
  ApplicationResult,
  HandlerContext,
} from '@api/http/handler';
import { HttpBoundaryError } from '@api/http/errors';
import {
  dispatchRuntimeRequest,
  RuntimeDispatchError,
  type RuntimeDispatchTarget,
} from '@api/runtime/turn-execution/runtime-dispatch';
import {
  type ThreadRuntimeCancelResult,
  type ThreadRuntimeFailureCode,
  type ThreadRuntimeResponseMetadata,
  type ThreadRuntimeTarget,
  type ThreadRuntimeTurnInput,
  type ThreadRuntimeTurnResult,
} from '@api/thread-runtime/admission';
import type { ThreadSnapshotResult } from '@api/thread-types';

/** Structural RPC surface keeps this adapter independent of the concrete DO implementation. */
export type RuntimeThreadStub = {
  readonly read: (ownerScopeRef: string) => Promise<ThreadSnapshotResult>;
  readonly runRuntimeTurn: (value: unknown) => Promise<ThreadRuntimeTurnResult>;
  readonly cancelRuntimeTurn: (value: unknown) => Promise<ThreadRuntimeCancelResult>;
  readonly listRuntimeResponses: (
    ownerScopeRef: string,
  ) => Promise<readonly ThreadRuntimeResponseMetadata[]>;
};

export type RuntimeThreadNamespace = {
  readonly getByName: (name: string) => RuntimeThreadStub;
};

export type RuntimeBootstrapOptions = {
  readonly threads: RuntimeThreadNamespace;
  readonly waitUntil?: (promise: Promise<void>) => void;
  /** Receives a fixed code; cancellation errors and their messages never cross this boundary. */
  readonly onCancellationError?: (classification: RuntimeCancellationClassification) => void;
};

export type RuntimeCancellationClassification = 'CANCELLATION_FAILED';

const internal = (): HttpBoundaryError => new HttpBoundaryError({ status: 500, code: 'INTERNAL' });

const invalidArgument = (): HttpBoundaryError =>
  new HttpBoundaryError({ status: 400, code: 'INVALID_ARGUMENT' });

const threadFailure = (code: ThreadRuntimeFailureCode): HttpBoundaryError => {
  switch (code) {
    case 'INVALID_ARGUMENT':
      return invalidArgument();
    case 'NOT_FOUND':
      return new HttpBoundaryError({ status: 404, code: 'NOT_FOUND' });
    case 'FORBIDDEN':
      return new HttpBoundaryError({ status: 403, code: 'FORBIDDEN' });
    case 'CANCELLED':
      return new HttpBoundaryError({ status: 409, code: 'CANCELLED' });
    case 'STALE_TURN':
      return new HttpBoundaryError({ status: 409, code: 'STALE_TURN' });
    case 'REVISION_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
    case 'TURN_ALREADY_ACTIVE':
      return new HttpBoundaryError({ status: 409, code: 'CONFLICT' });
    case 'RUNTIME_UNCONFIGURED':
    case 'RUNTIME_FAILED':
      return new HttpBoundaryError({ status: 502, code: 'PROVIDER_UNAVAILABLE' });
  }
};

const runtimeResultFailure = (result: ThreadRuntimeTurnResult): HttpBoundaryError => {
  if (result.status === 'cancelled') return threadFailure('CANCELLED');
  if (result.status === 'stale') return threadFailure('STALE_TURN');
  return threadFailure(result.code ?? 'RUNTIME_FAILED');
};

const threadResultFailure = (result: ThreadSnapshotResult): HttpBoundaryError => {
  if (result.ok) return internal();
  switch (result.code) {
    case 'NOT_FOUND':
      return new HttpBoundaryError({ status: 404, code: 'NOT_FOUND' });
    case 'FORBIDDEN':
      return new HttpBoundaryError({ status: 403, code: 'FORBIDDEN' });
    case 'REVISION_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
      return new HttpBoundaryError({ status: 409, code: 'CONFLICT' });
  }
};

const encodeHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** The null turn ID is replaced by a stable server ID derived from the authenticated request. */
export const serverTurnId = async (
  ownerScopeRef: string,
  threadId: string,
  idempotencyKey: string,
): Promise<string> => {
  const value = `${ownerScopeRef}\u0000${threadId}\u0000${idempotencyKey}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `turn-${encodeHex(new Uint8Array(digest))}`;
};

const asThreadTurnInput = (input: SearchRequest | ThreadTurnRequest): ThreadTurnRequest => {
  if (!('threadId' in input)) return input;
  const { threadId: _threadId, ...turn } = input;
  void _threadId;
  return turn;
};

const threadIdFor = (
  operation: Extract<ApplicationOperation, { kind: 'search' | 'turn' }>,
): string => (operation.kind === 'search' ? operation.input.threadId : operation.path.threadId);

const buildTarget = async (
  operation: Extract<ApplicationOperation, { kind: 'search' | 'turn' }>,
  context: HandlerContext,
): Promise<{ readonly target: ThreadRuntimeTarget; readonly input: ThreadTurnRequest }> => {
  const input = asThreadTurnInput(operation.input);
  if (input.revision >= Number.MAX_SAFE_INTEGER) throw invalidArgument();
  const threadId = threadIdFor(operation);
  const turnId =
    input.turnId ?? (await serverTurnId(context.ownerScopeRef, threadId, input.idempotencyKey));
  return {
    target: {
      ownerScopeRef: context.ownerScopeRef,
      threadId,
      turnId,
      revision: input.revision,
    },
    input,
  };
};

const cancelFailure = (result: ThreadRuntimeCancelResult): Error | undefined =>
  result.status === 'rejected' ? new Error('runtime cancellation was rejected') : undefined;

const runRuntime = async (
  operation: Extract<ApplicationOperation, { kind: 'search' | 'turn' }>,
  context: HandlerContext,
  options: RuntimeBootstrapOptions,
): Promise<ApplicationResult> => {
  const built = await buildTarget(operation, context);
  const stub = options.threads.getByName(built.target.threadId);
  const runtimeInput: ThreadRuntimeTurnInput = {
    ...built.target,
    deviceId: context.deviceId,
    idempotencyKey: built.input.idempotencyKey,
    input: built.input,
  };
  let result: ThreadRuntimeTurnResult;
  try {
    const dispatchOptions = {
      target: built.target,
      signal: context.signal,
      run: () => stub.runRuntimeTurn(runtimeInput),
      cancel: async (target: RuntimeDispatchTarget) => {
        const cancellation = await stub.cancelRuntimeTurn(target);
        const error = cancelFailure(cancellation);
        if (error !== undefined) throw error;
      },
      onCancellationError: () => options.onCancellationError?.('CANCELLATION_FAILED'),
    };
    result = await dispatchRuntimeRequest(
      options.waitUntil === undefined
        ? dispatchOptions
        : { ...dispatchOptions, waitUntil: options.waitUntil },
    );
  } catch (error: unknown) {
    if (error instanceof RuntimeDispatchError) throw threadFailure('CANCELLED');
    throw error;
  }
  if (result.status !== 'completed') throw runtimeResultFailure(result);
  if (isReferenceOnly(result.response)) throw threadFailure('IDEMPOTENCY_CONFLICT');

  const parsed = v.safeParse(AssistantResponseSchema, result.response);
  const expectedRevision = built.target.revision + 1;
  if (
    !parsed.success ||
    parsed.output.threadId !== built.target.threadId ||
    parsed.output.turnId !== built.target.turnId ||
    parsed.output.revision !== expectedRevision
  ) {
    throw internal();
  }
  const response = v.safeParse(SearchResponseSchema, {
    requestId: context.requestId,
    response: parsed.output,
    warnings: [],
  });
  if (!response.success) throw internal();
  return { kind: operation.kind, response: response.output };
};

const isRuntimeStatus = (value: unknown): value is ThreadRuntimeResponseMetadata['status'] =>
  value === 'completed' || value === 'cancelled' || value === 'failed' || value === 'stale';

const isReferenceOnly = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'restoreMode' in value &&
  value.restoreMode === 'reference_only';

const readRuntime = async (
  operation: Extract<ApplicationOperation, { kind: 'read_thread' | 'replay_thread' }>,
  context: HandlerContext,
  options: RuntimeBootstrapOptions,
): Promise<ApplicationResult> => {
  const threadId = operation.path.threadId;
  const stub = options.threads.getByName(threadId);
  const snapshot = await stub.read(context.ownerScopeRef);
  if (!snapshot.ok) throw threadResultFailure(snapshot);
  if (
    snapshot.snapshot.threadId !== threadId ||
    snapshot.snapshot.ownerScopeRef !== context.ownerScopeRef
  ) {
    throw internal();
  }
  const metadata = await stub.listRuntimeResponses(context.ownerScopeRef);
  const records: Array<Record<string, unknown>> = [];
  for (const entry of metadata) {
    if (!isRuntimeStatus(entry.status)) throw internal();
    if (entry.status !== 'completed') continue;
    if (
      entry.responseId === null ||
      entry.kind === null ||
      entry.presentation === null ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 1
    ) {
      throw internal();
    }
    records.push({
      turnId: entry.turnId,
      responseId: entry.responseId,
      revision: entry.revision,
      kind: entry.kind,
      presentation: entry.presentation,
      cardSetId: entry.cardSetId,
      restoreMode: 'reference_only',
    });
  }
  const latestSnapshot = await stub.read(context.ownerScopeRef);
  if (!latestSnapshot.ok) throw threadResultFailure(latestSnapshot);
  if (
    latestSnapshot.snapshot.threadId !== threadId ||
    latestSnapshot.snapshot.ownerScopeRef !== context.ownerScopeRef
  ) {
    throw internal();
  }
  const response = v.safeParse(ThreadReadResponseSchema, {
    schemaVersion: 'v1',
    requestId: context.requestId,
    threadId: latestSnapshot.snapshot.threadId,
    revision: latestSnapshot.snapshot.revision,
    active: latestSnapshot.snapshot.active,
    responses: records,
  });
  if (!response.success) throw internal();
  const result: ApplicationResult = {
    kind: operation.kind,
    response: response.output,
  };
  return result;
};

/** Runtime-only application surface used by Bootstrap; all other operations stay in bootstrap.ts. */
export const createRuntimeApplicationHandler = (
  options: RuntimeBootstrapOptions,
): ApplicationHandler => ({
  handle(operation, context) {
    switch (operation.kind) {
      case 'search':
      case 'turn':
        return runRuntime(operation, context, options);
      case 'read_thread':
      case 'replay_thread':
        return readRuntime(operation, context, options);
      case 'create_thread':
      case 'lifecycle':
      case 'delete_thread':
      case 'saved_reference_refresh':
      case 'prefs_read':
      case 'prefs_write':
      case 'saved_reference_list':
      case 'saved_reference_create':
      case 'saved_reference_delete':
      case 'place_decide':
        return Promise.reject(internal());
    }
  },
});
