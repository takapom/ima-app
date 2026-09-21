import {
  PlaceDecideRequestSchema,
  PlaceDecideResponseSchema,
  SavedReferenceCreateRequestSchema,
  SavedReferenceCreateResponseSchema,
} from '@ima/contracts';
import { toErrorResponse, type BoundaryFailure } from '@worker/adapters/in/http/errors';
import type { AuthenticatedContext } from '@worker/adapters/in/http/auth';
import { parseJsonBodyWithRaw } from '@worker/adapters/in/http/input';
import type {
  ApplicationHandler,
  ApplicationOperation,
  ApplicationResult,
  HandlerContext,
} from '@worker/adapters/in/http/handler';
import type { MatchedRoute } from '@worker/adapters/in/http/http-route';
import type { CancellationToken } from '@worker/application/ports/context';
import * as v from 'valibot';

export type ThreadPlaceWriteRoute = Extract<
  MatchedRoute,
  { readonly kind: 'saved_reference_create' | 'place_decide' }
>;

export type ThreadPlaceWriteInput = {
  readonly route: ThreadPlaceWriteRoute;
  readonly request: Request;
  readonly auth: AuthenticatedContext;
  readonly application: ApplicationHandler;
  readonly serverNow: string;
  readonly maxBodyBytes: number;
  readonly checkResource: (
    ownerScopeRef: string,
    threadId: string,
  ) => Promise<BoundaryFailure | null>;
  readonly checkIntegrity: (rawBody: Uint8Array) => Promise<Response | null>;
};

const cancelled = (): BoundaryFailure => ({ status: 409, code: 'CANCELLED' });

const bodyRequestId = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || !('requestId' in value)) return null;
  return typeof value.requestId === 'string' ? value.requestId : null;
};

const makeContext = (
  request: Request,
  auth: AuthenticatedContext,
  serverNow: string,
): HandlerContext => {
  const cancellation: CancellationToken = { isCancelled: () => request.signal.aborted };
  return { ...auth, serverNow, cancellation, signal: request.signal };
};

export const isThreadPlaceWriteRoute = (route: MatchedRoute): route is ThreadPlaceWriteRoute =>
  route.kind === 'saved_reference_create' || route.kind === 'place_decide';

export const handleThreadPlaceWriteRoute = async (
  input: ThreadPlaceWriteInput,
): Promise<Response> => {
  const requestId = input.auth.requestId;
  const threadFailure = await input.checkResource(
    input.auth.ownerScopeRef,
    input.route.path.threadId,
  );
  if (threadFailure !== null) return toErrorResponse(requestId, threadFailure);
  const schema =
    input.route.kind === 'place_decide'
      ? PlaceDecideRequestSchema
      : SavedReferenceCreateRequestSchema;
  const parsed = await parseJsonBodyWithRaw(input.request, schema, input.maxBodyBytes);
  if (!parsed.ok) return toErrorResponse(requestId, parsed.failure);
  if (bodyRequestId(parsed.value) !== requestId) {
    return toErrorResponse(requestId, { status: 400, code: 'INVALID_ARGUMENT' });
  }
  if (input.request.signal.aborted) return toErrorResponse(requestId, cancelled());
  const integrity = await input.checkIntegrity(parsed.rawBody);
  if (integrity !== null) return integrity;
  const operation: ApplicationOperation =
    input.route.kind === 'place_decide'
      ? { kind: 'place_decide', path: input.route.path, input: parsed.value }
      : { kind: 'saved_reference_create', path: input.route.path, input: parsed.value };
  const result = await input.application.handle(
    operation,
    makeContext(input.request, input.auth, input.serverNow),
  );
  const expectedKind: ApplicationResult['kind'] =
    input.route.kind === 'place_decide' ? 'place_decide' : 'saved_reference_create';
  if (result.kind !== expectedKind) {
    return toErrorResponse(requestId, { status: 500, code: 'INTERNAL' });
  }
  const responseSchema =
    input.route.kind === 'place_decide'
      ? PlaceDecideResponseSchema
      : SavedReferenceCreateResponseSchema;
  const checked = v.safeParse(responseSchema, result.response);
  if (!checked.success) return toErrorResponse(requestId, { status: 500, code: 'INTERNAL' });
  return Response.json(checked.output, {
    status: 201,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
};
