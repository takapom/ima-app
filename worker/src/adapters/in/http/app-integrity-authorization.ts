import { toErrorResponse } from '@worker/adapters/in/http/errors';
import type { AuthenticatedContext } from '@worker/adapters/in/http/auth';
import type {
  AppIntegrityGate,
  AppIntegrityRoute,
} from '@worker/adapters/in/http/app-integrity-gate';

type AuthorizedRoute = { readonly kind: AppIntegrityRoute };

const cancelled = (requestId: string): Response =>
  toErrorResponse(requestId, { status: 409, code: 'CANCELLED' });

/**
 * Converts the verifier-owned decision into the public HTTP boundary.
 * Failure detail stays inside the gate so assertion, key, and store state
 * cannot become an externally observable error code.
 */
export const authorizeAppIntegrity = async (input: {
  readonly gate: AppIntegrityGate | undefined;
  readonly request: Request;
  readonly route: AuthorizedRoute;
  readonly auth: AuthenticatedContext;
  readonly serverNow: string;
  readonly maxBodyBytes: number;
  readonly rawBody?: Uint8Array | undefined;
}): Promise<Response | null> => {
  if (input.request.signal.aborted) return cancelled(input.auth.requestId);
  if (input.gate === undefined) return null;
  let decision: Awaited<ReturnType<AppIntegrityGate['authorize']>>;
  try {
    decision = await input.gate.authorize({
      route: input.route.kind,
      ownerScopeRef: input.auth.ownerScopeRef,
      deviceId: input.auth.deviceId,
      request: input.request,
      now: input.serverNow,
      maxBodyBytes: input.maxBodyBytes,
      rawBody: input.rawBody,
    });
  } catch {
    return input.request.signal.aborted
      ? cancelled(input.auth.requestId)
      : toErrorResponse(input.auth.requestId, { status: 401, code: 'UNAUTHORIZED' });
  }
  if (input.request.signal.aborted) return cancelled(input.auth.requestId);
  return decision.allowed
    ? null
    : toErrorResponse(input.auth.requestId, { status: 401, code: 'UNAUTHORIZED' });
};
