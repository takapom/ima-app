import * as v from 'valibot';
import {
  AppAttestEnrollRequestSchema,
  AppAttestEnrollResponseSchema,
  AppAttestNonceResponseSchema,
  AppAttestRevokeRequestSchema,
  AppAttestRevokeResponseSchema,
} from '@ima/contracts';
import type { AuthenticatedContext } from '@worker/adapters/in/http/auth';
import { toErrorResponse } from '@worker/adapters/in/http/errors';
import { parseJsonBodyWithRaw } from '@worker/adapters/in/http/input';
import type { MatchedRoute } from '@worker/adapters/in/http/http-route';
import type { AppIntegrityGate } from '@worker/adapters/in/http/app-integrity-gate';

export type AppIntegrityHttpRoute = Extract<
  MatchedRoute,
  { readonly kind: 'attest_nonce' | 'attest_enroll' | 'attest_revoke' }
>;

export type AppIntegrityHttpRouteInput = {
  readonly route: AppIntegrityHttpRoute;
  readonly request: Request;
  readonly auth: AuthenticatedContext;
  readonly gate: AppIntegrityGate | undefined;
  readonly serverNow: string;
  readonly maxBodyBytes: number;
};

const unauthorized = (requestId: string): Response =>
  toErrorResponse(requestId, { status: 401, code: 'UNAUTHORIZED' });

const cancelled = (requestId: string): Response =>
  toErrorResponse(requestId, { status: 409, code: 'CANCELLED' });

const invalid = (requestId: string): Response =>
  toErrorResponse(requestId, { status: 400, code: 'INVALID_ARGUMENT' });

const jsonResponse = <Schema extends v.GenericSchema>(
  schema: Schema,
  value: unknown,
  requestId: string,
): Response => {
  const parsed = v.safeParse(schema, value);
  if (!parsed.success) return unauthorized(requestId);
  if (
    typeof parsed.output !== 'object' ||
    parsed.output === null ||
    !('requestId' in parsed.output) ||
    parsed.output.requestId !== requestId
  ) {
    return unauthorized(requestId);
  }
  return Response.json(parsed.output, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
};

const bodyRequestId = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || !('requestId' in value)) return null;
  return typeof value.requestId === 'string' ? value.requestId : null;
};

const parseBody = async <Schema extends v.GenericSchema>(
  request: Request,
  schema: Schema,
  maxBodyBytes: number,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly value: v.InferOutput<Schema> }
  | { readonly ok: false; readonly response: Response }
> => {
  const parsed = await parseJsonBodyWithRaw(request, schema, maxBodyBytes);
  if (!parsed.ok) return { ok: false, response: toErrorResponse(requestId, parsed.failure) };
  return bodyRequestId(parsed.value) === requestId
    ? { ok: true, value: parsed.value }
    : { ok: false, response: invalid(requestId) };
};

export const isAppIntegrityHttpRoute = (route: MatchedRoute): route is AppIntegrityHttpRoute =>
  route.kind === 'attest_nonce' || route.kind === 'attest_enroll' || route.kind === 'attest_revoke';

/**
 * Handles only the authenticated App Attest lifecycle routes. The caller performs the shared
 * app-token authentication and rate admission before invoking this adapter.
 */
export const handleAppIntegrityHttpRoute = async (
  input: AppIntegrityHttpRouteInput,
): Promise<Response> => {
  const requestId = input.auth.requestId;
  const gate = input.gate;
  if (gate === undefined) return unauthorized(requestId);
  if (input.request.signal.aborted) return cancelled(requestId);

  if (input.route.kind === 'attest_nonce') {
    try {
      const response = await gate.issueNonce({
        ownerScopeRef: input.auth.ownerScopeRef,
        deviceId: input.auth.deviceId,
        requestId,
        now: input.serverNow,
      });
      if (input.request.signal.aborted) return cancelled(requestId);
      return jsonResponse(AppAttestNonceResponseSchema, response, requestId);
    } catch {
      return unauthorized(requestId);
    }
  }

  const schema =
    input.route.kind === 'attest_enroll'
      ? AppAttestEnrollRequestSchema
      : AppAttestRevokeRequestSchema;
  const body = await parseBody(input.request, schema, input.maxBodyBytes, requestId);
  if (!body.ok) return body.response;
  if (input.request.signal.aborted) return cancelled(requestId);

  if (input.route.kind === 'attest_enroll') {
    let result: Awaited<ReturnType<AppIntegrityGate['enroll']>>;
    try {
      result = await gate.enroll({
        ownerScopeRef: input.auth.ownerScopeRef,
        deviceId: input.auth.deviceId,
        request: body.value,
        now: input.serverNow,
      });
    } catch {
      return unauthorized(requestId);
    }
    if (input.request.signal.aborted) return cancelled(requestId);
    return result.registered
      ? jsonResponse(
          AppAttestEnrollResponseSchema,
          { schemaVersion: 'v1', requestId, registered: true },
          requestId,
        )
      : unauthorized(requestId);
  }

  let revoked: boolean;
  try {
    revoked = await gate.revoke({
      ownerScopeRef: input.auth.ownerScopeRef,
      deviceId: input.auth.deviceId,
      keyId: body.value.keyId,
    });
  } catch {
    return unauthorized(requestId);
  }
  if (input.request.signal.aborted) return cancelled(requestId);
  return revoked
    ? jsonResponse(
        AppAttestRevokeResponseSchema,
        { schemaVersion: 'v1', requestId, revoked: true },
        requestId,
      )
    : unauthorized(requestId);
};
